'use strict'

// Runs every diagnostic-lab scenario against an in-process server with a real HTTP client, then prints, per
// scenario: what the client saw, the access-log record, and a reading derived from the record alone.
//
//   node lab.js           print the comparison
//   node lab.js --check   also assert the expected record shape per scenario; exit code 1 on any mismatch
//   node lab.js --log=lab.jsonl   also write every delivered record as a JSON line, e.g. for `express-observe analyze`

const http = require('node:http')
const net = require('node:net')
const { createApp, HOST, WAIT_BEFORE_HEADERS_MS, SLOW_BODY, L7_RESPONSE_AFTER_MS, SLOW_SINK_MS, CPU_WORK_MS, LARGE_ITEM_COUNT, burnCpu } = require('./app')

const fs = require('node:fs')

const CHECK = process.argv.includes('--check')
const LOG_ARG = process.argv.find((a) => a.startsWith('--log='))
const LOG_FILE = LOG_ARG ? LOG_ARG.slice('--log='.length) : null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const msSince = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
const round1 = (n) => Math.round(n * 10) / 10

// ---------------------------------------------------------------------------------------------------------------
// Client side. clientAttemptMs is one physical HTTP attempt as the client saw it (ARCHITECTURE.md section 9).

function fetchOnce (port, path) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    http.get({ host: HOST, port, path, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, clientAttemptMs: msSince(t0) }))
    }).on('error', reject)
  })
}

async function disconnectBeforeHeaders (port, path, afterMs) {
  const t0 = process.hrtime.bigint()
  const socket = net.connect(port, HOST)
  socket.on('error', () => {})
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
  await sleep(afterMs)
  socket.destroy()
  return { status: null, headers: {}, body: '', clientAttemptMs: msSince(t0), disconnected: true }
}

function disconnectAfterFirstChunk (port, path) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    const req = http.get({ host: HOST, port, path, agent: false }, (res) => {
      res.once('data', () => {
        req.destroy()
        resolve({ status: res.statusCode, headers: res.headers, body: '', clientAttemptMs: msSince(t0), disconnected: true })
      })
    })
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err) })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Reading. Uses only the record's own fields; it is never told which scenario produced the record.

function interpret (record) {
  const notes = []
  if (record.route === null) notes.push('route unknown (no route matched, or the response was not labelled)')

  if (record.termination === 'interrupted') {
    notes.push(record.status === null
      ? 'the connection ended before any header was sent; this record cannot say whether the client gave up, a proxy timed out, or the network failed'
      : `headers (status ${record.status}) were sent but the body was not completely handed to the OS; the cause of the disconnect is unknown`)
    return notes
  }

  if (record.status >= 500) notes.push('the server answered with an error; the cause lives in the application\'s own error handling, not in this record')
  if (typeof record.eventLoopDelayMs === 'number' && record.eventLoopDelayMs >= 50) {
    notes.push(`the process's event loop was blocked for about ${Math.round(record.eventLoopDelayMs)} ms around this request; clients may have waited that long before this record's clock started, and the record cannot say which code blocked it`)
  }

  const header = record.headerDurationMs
  const total = record.durationMs
  if (total < 20) {
    notes.push('fast on the server side; if a user felt slowness, it happened outside what this record measures (unknown)')
  } else if (header !== null && header >= 0.8 * total) {
    notes.push('most of the time passed before headers were sent; the record does not say which work or dependency caused it')
  } else {
    notes.push('headers went out early and most of the time was spent on the body; the record cannot separate slow production from a slow reader')
  }
  return notes
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios

/**
 * Each scenario: run(port) performs the client side; find(result) says which record belongs to it;
 * expect(ctx) returns a list of failed expectations (used with --check).
 */
const SCENARIOS = [
  {
    id: 'L0',
    title: 'normal small JSON',
    run: (port) => fetchOnce(port, '/lab/l0'),
    expect: ({ record, result }) => [
      is(result.status === 200, 'client got 200'),
      is(record.status === 200 && record.termination === 'finished', 'record: finished 200'),
      is(record.route === '/lab/l0', 'record: route /lab/l0')
    ]
  },
  {
    id: 'L1',
    title: `wait ${WAIT_BEFORE_HEADERS_MS.long} ms before headers ("late headers")`,
    run: (port) => fetchOnce(port, '/lab/l1/long'),
    expect: ({ record, result }) => [
      is(record.route === '/lab/l1/:profile', 'record: route is the template, not "long"'),
      is(record.headerDurationMs >= WAIT_BEFORE_HEADERS_MS.long * 0.9, 'record: headerDurationMs covers the wait'),
      is(/wait;dur=/.test(result.headers['server-timing'] ?? ''), 'header: Server-Timing has the custom "wait" metric')
    ]
  },
  {
    id: 'L1',
    title: 'unknown profile answered 404 by a matched route',
    run: (port) => fetchOnce(port, '/lab/l1/huge'),
    expect: ({ record }) => [
      is(record.status === 404, 'record: 404'),
      is(record.route === '/lab/l1/:profile', 'record: a matched route keeps its label on 404')
    ]
  },
  {
    id: 'L2',
    title: `headers at once, body in ${SLOW_BODY.long.chunks} chunks ("slow body")`,
    run: (port) => fetchOnce(port, '/lab/l2/long'),
    expect: ({ record }) => {
      const bodyMs = (SLOW_BODY.long.chunks - 1) * SLOW_BODY.long.intervalMs
      return [
        is(record.headerDurationMs < 50, 'record: headerDurationMs is short'),
        is(record.durationMs >= bodyMs * 0.9, 'record: durationMs covers the slow body'),
        is(record.termination === 'finished', 'record: finished')
      ]
    }
  },
  {
    id: 'L7',
    title: 'client disconnects before any header',
    run: (port) => disconnectBeforeHeaders(port, '/lab/l7/before-headers', 100),
    find: (records) => records.find((r) => r.route === '/lab/l7/before-headers'),
    expect: ({ record }) => [
      is(record.termination === 'interrupted', 'record: interrupted'),
      is(record.status === null, 'record: status null (Node\'s default 200 was never sent)'),
      is(record.headerDurationMs === null, 'record: headerDurationMs null'),
      is(record.durationMs < L7_RESPONSE_AFTER_MS, 'record: logged at disconnect, not when the server would have answered')
    ]
  },
  {
    id: 'L7',
    title: 'client disconnects after the first body chunk',
    run: (port) => disconnectAfterFirstChunk(port, '/lab/l7/mid-body'),
    expect: ({ record }) => [
      is(record.termination === 'interrupted', 'record: interrupted'),
      is(record.status === 200, 'record: the status that was actually sent'),
      is(typeof record.headerDurationMs === 'number', 'record: headerDurationMs present')
    ]
  },
  {
    id: 'L8',
    title: 'sink throws synchronously',
    run: (port) => fetchOnce(port, '/lab/l8/throwing-sink'),
    expectsSinkFailure: true,
    expect: ({ result, failure }) => [
      is(result.status === 200, 'client got 200: the response is unaffected'),
      is(failure !== undefined, 'onSinkError received the failure and the record')
    ]
  },
  {
    id: 'L8',
    title: 'sink rejects asynchronously',
    run: (port) => fetchOnce(port, '/lab/l8/rejecting-sink'),
    expectsSinkFailure: true,
    expect: ({ result, failure }) => [
      is(result.status === 200, 'client got 200: the response is unaffected'),
      is(failure !== undefined, 'onSinkError received the rejection and the record')
    ]
  },
  {
    id: 'L8',
    title: `sink takes ${SLOW_SINK_MS} ms`,
    run: (port) => fetchOnce(port, '/lab/l8/slow-sink'),
    expect: ({ result, recordWaitMs }) => [
      is(result.clientAttemptMs < SLOW_SINK_MS / 2, 'client was not kept waiting for the sink'),
      is(recordWaitMs >= SLOW_SINK_MS * 0.8, 'record was delivered later, by the slow sink')
    ]
  },
  {
    id: 'err',
    title: 'next(err) handled by the application error middleware',
    run: (port) => fetchOnce(port, '/lab/error'),
    expect: ({ record, result }) => [
      is(record.status === 500 && record.route === '/lab/error', 'record: 500 with route'),
      is(JSON.parse(result.body).requestId === result.headers['x-request-id'], 'body carries the request ID for support'),
      is(!result.body.includes('synthetic failure') && !result.body.includes(' at '), 'body has no error message or stack')
    ]
  },
  {
    id: '404',
    title: 'unmatched URL',
    run: (port) => fetchOnce(port, '/lab/does-not-exist/12345'),
    expect: ({ record }) => [
      is(record.status === 404 && record.route === null, 'record: 404 with route null')
    ]
  },
  {
    id: 'nest',
    title: 'nested router at a parameterized mount',
    run: (port) => fetchOnce(port, '/tenants/tenant-8841/items/item-5523'),
    expect: ({ record }) => [
      is(record.route === '/tenants/:tenantId/items/:itemId', 'record: full template'),
      is(!JSON.stringify(record).includes('8841') && !JSON.stringify(record).includes('5523'), 'record: no concrete IDs')
    ]
  }
]

// ---------------------------------------------------------------------------------------------------------------
// Second wave: scenarios that need several requests or client-side work. Each prints two kinds of lines:
//   reading   what the record alone supports (interpret(), unaware of the scenario)
//   actually  what the scenario did, which the records cannot show
// The gap between the two is the point of these scenarios.

const CLIENT_WORK_MS = 120

/**
 * Send GET requests from a worker thread after `delayMs`. The lab's server runs in this process, so a client on
 * the main thread would be frozen by the same blocked event loop it is trying to observe; a worker has its own.
 */
async function fetchFromWorker (port, paths, delayMs) {
  const { Worker } = require('node:worker_threads')
  const code = `
    const http = require('node:http')
    const { parentPort, workerData } = require('node:worker_threads')
    const msSince = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
    parentPort.once('message', () => setTimeout(async () => {
      const results = await Promise.all(workerData.paths.map((path) => new Promise((resolve, reject) => {
        const t0 = process.hrtime.bigint()
        http.get({ host: workerData.host, port: workerData.port, path, agent: false }, (res) => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode, requestId: res.headers['x-request-id'], clientAttemptMs: msSince(t0) }))
        }).on('error', reject)
      })))
      parentPort.postMessage({ results })
    }, workerData.delayMs))
    parentPort.postMessage({ ready: true })
  `
  const worker = new Worker(code, { eval: true, workerData: { host: HOST, port, paths, delayMs } })
  // Wait until the worker has loaded, so `go` starts its clock at a known moment.
  await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  const results = new Promise((resolve, reject) => {
    worker.once('message', (msg) => {
      resolve(msg.results)
      worker.terminate()
    })
    worker.once('error', reject)
  })
  return { go: () => worker.postMessage('go'), results }
}

const COMPOSITE_SCENARIOS = [
  {
    id: 'L3',
    title: `${CPU_WORK_MS.long} ms of CPU work blocks three fast requests sent while it runs`,
    async run ({ port, findRecord }) {
      // The worker sends the fast requests 10 ms after `go`; the slow request is sent right after `go` and blocks
      // the server's event loop for CPU_WORK_MS once it is handled.
      const fastClient = await fetchFromWorker(port, ['/lab/l0', '/lab/l0', '/lab/l0'], 10)
      fastClient.go()
      const slow = await fetchOnce(port, '/lab/l3/long')
      const fast = await fastClient.results
      const slowRecord = await findRecord(slow.headers['x-request-id'])
      const fastRecords = await Promise.all(fast.map((f) => findRecord(f.requestId)))
      const fastMs = fast.map((f) => round1(f.clientAttemptMs))
      return {
        lines: [
          `client   /lab/l3/long ${round1(slow.clientAttemptMs)} ms (Server-Timing: ${slow.headers['server-timing']}); 3x /lab/l0: ${fastMs.join(', ')} ms`,
          `record   /lab/l3/long ${JSON.stringify(pick(slowRecord))}`,
          `record   3x /lab/l0 durationMs: ${fastRecords.map((r) => r && r.durationMs).join(', ')}; eventLoopDelayMs: ${fastRecords.map((r) => r && r.eventLoopDelayMs).join(', ')}`,
          `reading  /lab/l0: ${interpret(fastRecords[0]).join('; ')}`,
          'actually the fast requests waited for the blocked event loop before observe() even ran. durationMs cannot contain that wait; eventLoopDelayMs (enabled in this demo) shows that the process was blocked, which is the only server-side hint.'
        ],
        failures: [
          is(slowRecord && slowRecord.headerDurationMs >= CPU_WORK_MS.long * 0.9, 'slow record covers the CPU work'),
          is(/cpu;dur=/.test(slow.headers['server-timing'] ?? ''), 'Server-Timing names the CPU work'),
          is(Math.min(...fastMs) >= CPU_WORK_MS.long * 0.4, 'fast clients waited for the blocked event loop'),
          is(fastRecords.every((r) => r && r.durationMs < CPU_WORK_MS.long * 0.25), 'fast records look fast: the wait is not in durationMs'),
          is(fastRecords.every((r) => r && r.eventLoopDelayMs >= CPU_WORK_MS.long * 0.5), 'eventLoopDelayMs shows the block on the fast records')
        ]
      }
    }
  },
  {
    id: 'L4',
    title: `${LARGE_ITEM_COUNT.toLocaleString('en')} items as JSON: serialized per request vs prebuilt`,
    async run ({ port, findRecord }) {
      // One warm-up of each, so JIT and buffer allocation do not land on the measured pair.
      await fetchOnce(port, '/lab/l4/prebuilt')
      await fetchOnce(port, '/lab/l4/serialize')
      const prebuilt = await fetchOnce(port, '/lab/l4/prebuilt')
      const serialize = await fetchOnce(port, '/lab/l4/serialize')
      const pr = await findRecord(prebuilt.headers['x-request-id'])
      const sr = await findRecord(serialize.headers['x-request-id'])
      return {
        lines: [
          `client   prebuilt ${round1(prebuilt.clientAttemptMs)} ms, serialize ${round1(serialize.clientAttemptMs)} ms, ${Math.round(prebuilt.body.length / 1024)} KiB each`,
          `record   prebuilt ${JSON.stringify(pick(pr))}`,
          `record   serialize ${JSON.stringify(pick(sr))}`,
          `reading  serialize: ${interpret(sr).join('; ')}`,
          'actually res.json() runs JSON.stringify before any header can be written, so serialization shows up in headerDurationMs; the record cannot name it, and the client\'s own parsing is not in either record.'
        ],
        failures: [
          is(pr && sr && pr.status === 200 && sr.status === 200, 'both answered 200'),
          is(prebuilt.body.length === serialize.body.length, 'both sent the same document'),
          is(sr.headerDurationMs > pr.headerDurationMs + 3, 'serializing per request adds time before headers')
        ]
      }
    }
  },
  {
    id: 'L5',
    title: `fast API, then ${CLIENT_WORK_MS} ms of client-side work before the result is usable`,
    async run ({ port, findRecord }) {
      const t0 = process.hrtime.bigint()
      const attempt = await fetchOnce(port, '/lab/l0')
      JSON.parse(attempt.body)
      burnCpu(CLIENT_WORK_MS) // stands in for client-side processing and rendering
      const operationMs = msSince(t0)
      const record = await findRecord(attempt.headers['x-request-id'])
      return {
        lines: [
          `client   operationMs ${round1(operationMs)}, clientAttemptMs ${round1(attempt.clientAttemptMs)}`,
          `record   ${JSON.stringify(pick(record))}`,
          `reading  ${interpret(record).join('; ')}`,
          'actually the user waited for the client\'s own work. The server record is correct and fast, and says nothing about it.'
        ],
        failures: [
          is(operationMs >= CLIENT_WORK_MS, 'operation includes the client work'),
          is(record && record.durationMs < CLIENT_WORK_MS / 4, 'server record stays fast')
        ]
      }
    }
  },
  {
    id: 'L6',
    title: 'one user action, two HTTP attempts (503, then a retry)',
    async run ({ port, findRecord }) {
      const t0 = process.hrtime.bigint()
      const attempts = []
      for (let i = 0; i < 3; i++) {
        const a = await fetchOnce(port, '/lab/l6/flaky')
        attempts.push(a)
        if (a.status < 500) break
      }
      const operationMs = msSince(t0)
      const rs = await Promise.all(attempts.map((a) => findRecord(a.headers['x-request-id'])))
      return {
        lines: [
          `client   operationMs ${round1(operationMs)} over ${attempts.length} attempts: ${attempts.map((a) => `${a.status} in ${round1(a.clientAttemptMs)} ms`).join(', ')}`,
          ...rs.map((r, i) => `record   try ${i + 1} ${JSON.stringify(pick(r))}`),
          `reading  try 1: ${interpret(rs[0]).join('; ')}`,
          'actually one user action produced two requests with two request IDs. Each record is complete on its own; only a client-side operation ID could tie them together (see examples/react-native-correlation).'
        ],
        failures: [
          is(attempts.length === 2, 'exactly one retry'),
          is(rs.every(Boolean) && rs[0].status === 503 && rs[1].status === 200, 'server logged both attempts'),
          is(new Set(attempts.map((a) => a.headers['x-request-id'])).size === 2, 'each attempt has its own request ID')
        ]
      }
    }
  }
]

function is (condition, description) {
  return condition ? null : description
}

// ---------------------------------------------------------------------------------------------------------------
// Runner

async function waitFor (getter, timeoutMs = 2000) {
  const t0 = Date.now()
  for (;;) {
    const value = getter()
    if (value !== undefined) return value
    if (Date.now() - t0 > timeoutMs) return undefined
    await sleep(5)
  }
}

function printScenario (scenario, result, record, failure, failures) {
  const lines = []
  lines.push(`\n${scenario.id.padEnd(4)} ${scenario.title}`)
  const st = result.headers['server-timing'] ?? '-'
  const status = result.status === null ? 'none' : result.status
  lines.push(`  client   status ${status}  clientAttemptMs ${round1(result.clientAttemptMs)}${result.disconnected ? '  (client disconnected)' : ''}  Server-Timing: ${st}`)
  if (record) {
    lines.push(`  record   ${JSON.stringify(pick(record))}`)
    for (const note of interpret(record)) lines.push(`  reading  ${note}`)
  } else if (failure) {
    lines.push(`  record   not delivered: the sink failed and onSinkError got ${failure.err.name} for requestId ${failure.record.requestId}`)
  } else {
    lines.push('  record   (none arrived)')
  }
  if (CHECK) lines.push(failures.length === 0 ? '  check    ok' : failures.map((f) => `  check    FAILED: ${f}`).join('\n'))
  process.stdout.write(lines.join('\n') + '\n')
}

function pick (record) {
  const { route, status, headerDurationMs, durationMs, eventLoopDelayMs, termination } = record
  return eventLoopDelayMs === undefined
    ? { route, status, headerDurationMs, durationMs, termination }
    : { route, status, headerDurationMs, durationMs, eventLoopDelayMs, termination }
}

async function main () {
  const records = []
  const logStream = LOG_FILE ? fs.createWriteStream(LOG_FILE) : null
  const sinkFailures = []
  const app = createApp({
    write: (record) => {
      records.push(record)
      if (logStream) logStream.write(JSON.stringify(record) + '\n')
    },
    onSinkError: (err, record) => sinkFailures.push({ err, record })
  })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, HOST, () => resolve(s))
  })
  const { port } = server.address()

  process.stdout.write('diagnostic-lab: same symptom, different mechanisms. Readings come from each record alone.\n')
  process.stdout.write('clientAttemptMs minus durationMs is NOT "network time": the two clocks start and stop at different points.\n')

  let failed = 0
  for (const scenario of SCENARIOS) {
    const result = await scenario.run(port)
    const requestId = result.headers['x-request-id']
    const t0 = Date.now()

    let record
    let failure
    if (scenario.expectsSinkFailure) {
      failure = await waitFor(() => sinkFailures.find((f) => f.record.requestId === requestId))
    } else {
      record = await waitFor(() => (scenario.find ? scenario.find(records) : records.find((r) => r.requestId === requestId)))
    }
    const recordWaitMs = Date.now() - t0 + result.clientAttemptMs

    const failures = record === undefined && failure === undefined
      ? ['no record or sink failure arrived']
      : scenario.expect({ record, result, failure, recordWaitMs }).filter(Boolean)
    if (failures.length > 0) failed++
    printScenario(scenario, result, record, failure, failures)
  }

  const findRecord = (requestId) => waitFor(() => records.find((r) => r.requestId === requestId))
  for (const scenario of COMPOSITE_SCENARIOS) {
    const { lines, failures: checks } = await scenario.run({ port, findRecord })
    const failures = checks.filter(Boolean)
    if (failures.length > 0) failed++
    const out = [`\n${scenario.id.padEnd(4)} ${scenario.title}`, ...lines.map((l) => `  ${l}`)]
    if (CHECK) out.push(failures.length === 0 ? '  check    ok' : failures.map((f) => `  check    FAILED: ${f}`).join('\n'))
    process.stdout.write(out.join('\n') + '\n')
  }

  // Let L7 handlers that answer late run, and make sure they add no second record.
  await sleep(L7_RESPONSE_AFTER_MS + 100)
  const perRequest = new Map()
  for (const r of records) perRequest.set(r.requestId, (perRequest.get(r.requestId) ?? 0) + 1)
  const duplicates = [...perRequest.values()].filter((n) => n > 1).length
  if (CHECK && duplicates > 0) failed++

  server.closeAllConnections()
  server.close()
  if (logStream) await new Promise((resolve) => logStream.end(resolve))

  process.stdout.write(`\n${records.length} records delivered, ${sinkFailures.length} sink failures reported, ${duplicates} duplicate records.\n`)
  if (CHECK) {
    process.stdout.write(failed === 0 ? 'check: all scenarios behaved as expected\n' : `check: ${failed} scenario(s) failed\n`)
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main().catch((err) => {
  process.stderr.write(`diagnostic-lab failed: ${err && err.stack}\n`)
  process.exitCode = 1
})
