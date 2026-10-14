'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { createApp, SLOW_MS } = require('../server')
const { createTracedClient, parseServerTiming, formatAttemptLine } = require('../correlation')
const { joinAttempts, parseClientLines, parseServerLines, renderJoin } = require('../join')
const { runSession } = require('../node-client')

async function withServer (options, fn) {
  const records = []
  const app = createApp({ ...options, sink: (r) => records.push(r) })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const attempts = []
  const client = createTracedClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    newId: randomUUID,
    onAttempt: (a) => attempts.push(a)
  })
  try {
    await fn({ client, attempts, records, port: server.address().port })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('traced client against the example API', () => {
  test('one attempt: the server logs the client ID and both sides line up', () => withServer({}, async ({ client, attempts, records }) => {
    const result = await client.request('/api/items', { operationName: 'list' })
    await settle()
    expect(result.ok).toBe(true)
    expect(result.data.items).toHaveLength(20)

    const [a] = attempts
    expect(a).toMatchObject({ kind: 'client-attempt', attempt: 1, status: 200, outcome: 'ok', requestIdEchoed: true })
    expect(a.serverRequestId).toBe(a.requestId)
    expect(typeof a.serverAppMs).toBe('number')

    const [r] = records
    expect(r).toMatchObject({ requestId: a.requestId, requestIdSource: 'client', route: '/api/items', status: 200 })

    const [row] = joinAttempts(attempts, records)
    expect(row.matchedBy).toBe('sent-id')
    expect(row.clientAttemptMs).toBeGreaterThanOrEqual(r.durationMs)
    expect(row.notMeasuredByServerMs).toBeGreaterThanOrEqual(0)
  }))

  test('a server-side wait shows up in Server-Timing and in the server duration', () => withServer({}, async ({ client, attempts, records }) => {
    await client.request('/api/items/slow')
    await settle()
    const [a] = attempts
    const wait = a.serverTiming.find((m) => m.name === 'wait')
    expect(wait.dur).toBeGreaterThanOrEqual(SLOW_MS * 0.9)
    const [row] = joinAttempts(attempts, records)
    expect(row.server.headerDurationMs).toBeGreaterThanOrEqual(SLOW_MS * 0.9)
    expect(row.reading).toMatch(/inside the server's measured time/)
  }))

  test('a retry is one operation with two attempts and two request IDs', () => withServer({}, async ({ client, attempts, records }) => {
    const result = await client.request('/api/flaky', { maxAttempts: 3 })
    await settle()
    expect(result.ok).toBe(true)
    expect(result.operation.attempts.map((a) => a.status)).toEqual([503, 200])
    expect(new Set(attempts.map((a) => a.operationId)).size).toBe(1)
    expect(new Set(attempts.map((a) => a.requestId)).size).toBe(2)
    const rows = joinAttempts(attempts, records)
    expect(rows.map((r) => r.server.status)).toEqual([503, 200])
  }))

  test('a client timeout is matched to the interrupted server record by the ID the client sent', () => withServer({}, async ({ client, attempts, records }) => {
    const result = await client.request('/api/stall', { timeoutMs: 300 })
    await settle()
    expect(result.ok).toBe(false)
    expect(attempts[0]).toMatchObject({ outcome: 'timeout', status: null, serverRequestId: null })
    const [row] = joinAttempts(attempts, records)
    expect(row.server).toMatchObject({ termination: 'interrupted', status: null })
    expect(row.reading).toMatch(/client gave up/)
  }))

  test('without trustIncoming the join falls back to the response header ID', () => withServer({ trustIncoming: false }, async ({ client, attempts, records }) => {
    await client.request('/api/items')
    await settle()
    expect(attempts[0].requestIdEchoed).toBe(false)
    expect(records[0].requestIdSource).toBe('generated')
    const [row] = joinAttempts(attempts, records)
    expect(row.matchedBy).toBe('response-header')
    expect(row.server).not.toBeNull()
  }))

  test('without trustIncoming a client timeout cannot be matched, and the join says so', () => withServer({ trustIncoming: false }, async ({ client, attempts, records }) => {
    await client.request('/api/stall', { timeoutMs: 300 })
    await settle()
    const [row] = joinAttempts(attempts, records)
    expect(row.server).toBeNull()
    expect(row.reading).toMatch(/Unknown which/)
  }))

  test('an unreachable server is a network error with no server record', async () => {
    const records = []
    const app = createApp({ sink: (r) => records.push(r) })
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    const attempts = []
    const client = createTracedClient({ baseUrl: `http://127.0.0.1:${port}`, newId: randomUUID, onAttempt: (a) => attempts.push(a) })
    const result = await client.request('/api/items', { maxAttempts: 2 })
    expect(result.ok).toBe(false)
    expect(attempts.map((a) => a.outcome)).toEqual(['network-error', 'network-error'])
    const rows = joinAttempts(attempts, records)
    expect(rows.every((r) => r.server === null)).toBe(true)
  })
})

describe('client contract', () => {
  test('an ID generator that produces invalid IDs is rejected before any request', async () => {
    let called = false
    const client = createTracedClient({ baseUrl: 'http://127.0.0.1:1', newId: () => 'not valid!', fetchImpl: async () => { called = true } })
    await expect(client.request('/x')).rejects.toThrow(TypeError)
    expect(called).toBe(false)
  })

  test('paths must start with a slash', async () => {
    const client = createTracedClient({ baseUrl: 'http://127.0.0.1:1', newId: randomUUID })
    await expect(client.request('api/items')).rejects.toThrow(TypeError)
  })

  test('maxAttempts is capped at 5', () => withServer({}, async ({ client, attempts }) => {
    await client.request('/api/items/does-not-exist', { maxAttempts: 50, retryOn: () => true })
    expect(attempts).toHaveLength(5)
  }))

  test('parseServerTiming is lenient with unknown or malformed metrics', () => {
    expect(parseServerTiming('db;dur=12.5, cache;desc="hit, warm", app;dur=14.0')).toEqual([
      { name: 'db', dur: 12.5, desc: null },
      { name: 'cache', dur: null, desc: 'hit, warm' },
      { name: 'app', dur: 14, desc: null }
    ])
    expect(parseServerTiming('bad name;dur=1, app;dur=x')).toEqual([{ name: 'app', dur: null, desc: null }])
    expect(parseServerTiming(null)).toEqual([])
  })
})

describe('join input and output', () => {
  test('client lines are found inside Metro-style console output', () => {
    const attempt = { kind: 'client-attempt', requestId: 'abc', operationId: 'op', attempt: 1 }
    const lines = [
      ' LOG  Bundled 1234ms index.js',
      ` LOG  ${formatAttemptLine(attempt)}`,
      `${formatAttemptLine({ ...attempt, requestId: 'def' })}`,
      'client-attempt {not json'
    ]
    expect(parseClientLines(lines).map((a) => a.requestId)).toEqual(['abc', 'def'])
  })

  test('server lines accept wrapped records and skip everything else', () => {
    const lines = [
      'server started',
      JSON.stringify({ level: 30, schemaVersion: 1, requestId: 'a', termination: 'finished' }),
      JSON.stringify({ schemaVersion: 2, requestId: 'b', termination: 'finished' })
    ]
    expect(parseServerLines(lines).map((r) => r.requestId)).toEqual(['a'])
  })

  test('duplicate server records for one ID are flagged', () => {
    const client = [{ kind: 'client-attempt', requestId: 'x', attempt: 1, outcome: 'ok', status: 200, clientAttemptMs: 50, operationName: 'op' }]
    const rec = { schemaVersion: 1, requestId: 'x', termination: 'finished', status: 200, durationMs: 10, headerDurationMs: 5 }
    const [row] = joinAttempts(client, [rec, rec])
    expect(row.duplicateServerRecords).toBe(2)
    expect(row.reading).toMatch(/2 server records share this ID/)
  })

  test('the rendered table never calls the difference network time, and strips control characters', () => {
    const rows = joinAttempts(
      [{ kind: 'client-attempt', requestId: 'x', attempt: 1, outcome: 'ok', status: 200, clientAttemptMs: 50, operationName: 'op\u001b[31m' }],
      [{ schemaVersion: 1, requestId: 'x', termination: 'finished', status: 200, durationMs: 10, headerDurationMs: 5 }]
    )
    const text = renderJoin(rows)
    expect(text).toMatch(/It is not network time/)
    expect(text).not.toMatch(/\u001b/)
  })

  test('the full node-client session and the join CLI agree', async () => {
    const { clientAttempts, serverRecords } = await runSession()
    expect(clientAttempts.map((a) => a.operationName)).toEqual([
      'list (small)', 'list (large)', 'slow list', 'flaky, with retry', 'flaky, with retry', 'stall, client gives up'
    ])

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-correlation-'))
    try {
      fs.writeFileSync(path.join(dir, 'client.log'), clientAttempts.map((a) => ` LOG  ${formatAttemptLine(a)}`).join('\n'))
      fs.writeFileSync(path.join(dir, 'access.jsonl'), serverRecords.map((r) => JSON.stringify(r)).join('\n'))
      const stdout = await new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, '..', 'join-cli.js'), path.join(dir, 'client.log'), path.join(dir, 'access.jsonl'), '--json'],
          { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)))
      })
      const rows = JSON.parse(stdout)
      expect(rows).toHaveLength(6)
      expect(rows.every((r) => r.server !== null)).toBe(true)
      expect(rows.at(-1).server.termination).toBe('interrupted')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
