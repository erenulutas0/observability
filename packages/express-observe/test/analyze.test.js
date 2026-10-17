'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawnSync } = require('node:child_process')
const express = require('express')
const request = require('supertest')
const observe = require('../src')
const { listen, sleep } = require('./helpers/http')

const BIN = path.join(__dirname, '..', 'bin', 'express-observe.js')

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'express-observe-analyze-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function cli (args, input) {
  const result = spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function json (args, input) {
  const result = cli([...args, '--json'], input)
  if (result.status !== 0) throw new Error(`exit ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

let fileCounter = 0
function writeLog (lines, eol = '\n') {
  const file = path.join(tmp, `log-${++fileCounter}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(eol) + eol)
  return file
}

let idCounter = 0
/** A synthetic record with sensible defaults. */
function rec (overrides = {}) {
  return {
    schemaVersion: 1,
    timestamp: '2026-10-14T08:00:00.000Z',
    requestId: `req-${++idCounter}`,
    requestIdSource: 'generated',
    service: 'synthetic-api',
    release: '1.0.0',
    method: 'GET',
    route: '/users/:id',
    status: 200,
    headerDurationMs: 1,
    durationMs: 2,
    termination: 'finished',
    ...overrides
  }
}

const group = (report, key) => report.groups.find((g) => g.key === key)

describe('analyze: statistics', () => {
  test('nearest-rank p50/p95/p99/max over 100 finished requests', () => {
    const lines = Array.from({ length: 100 }, (_, i) => rec({ durationMs: i + 1, headerDurationMs: (i + 1) / 2 }))
    const report = json(['analyze', writeLog(lines)])
    const g = group(report, 'GET /users/:id')
    expect(g.durationMs).toEqual({ n: 100, p50: 50, p95: 95, p99: 99, max: 100 })
    expect(g.headerDurationMs).toEqual({ n: 100, p50: 25, p95: 47.5, p99: 49.5 })
  })

  test('p95 needs 20 values and p99 needs 100; below that they are null, not guessed', () => {
    const small = Array.from({ length: 19 }, (_, i) => rec({ route: '/small', durationMs: i + 1 }))
    const medium = Array.from({ length: 20 }, (_, i) => rec({ route: '/medium', durationMs: i + 1 }))
    const report = json(['analyze', writeLog([...small, ...medium])])
    expect(group(report, 'GET /small').durationMs).toMatchObject({ n: 19, p50: 10, p95: null, p99: null, max: 19 })
    expect(group(report, 'GET /medium').durationMs).toMatchObject({ n: 20, p95: 19, p99: null })
    expect(report.notes.join(' ')).toMatch(/too few finished requests/)
  })

  test('interrupted requests are counted but excluded from latency percentiles', () => {
    const lines = [
      ...Array.from({ length: 5 }, () => rec({ durationMs: 10 })),
      ...Array.from({ length: 3 }, () => rec({ termination: 'interrupted', status: null, headerDurationMs: null, durationMs: 9000 }))
    ]
    const g = group(json(['analyze', writeLog(lines)]), 'GET /users/:id')
    expect(g).toMatchObject({ count: 8, finished: 5, interrupted: 3, interruptedRate: 0.375 })
    expect(g.status.none).toBe(3)
    expect(g.durationMs.max).toBe(10)
  })

  test('status classes and 5xx rate', () => {
    const lines = [
      ...Array.from({ length: 6 }, () => rec({ status: 200 })),
      rec({ status: 304 }),
      rec({ status: 404 }),
      rec({ status: 500 }),
      rec({ status: 503 })
    ]
    const g = group(json(['analyze', writeLog(lines)]), 'GET /users/:id')
    expect(g.status).toEqual({ '1xx': 0, '2xx': 6, '3xx': 1, '4xx': 1, '5xx': 2, none: 0 })
    expect(g.errorRate5xx).toBe(0.2)
  })

  test('a null route is its own group and produces an honest note', () => {
    const report = json(['analyze', writeLog([rec({ route: null, status: 404 }), rec()])])
    expect(group(report, 'GET (unknown route)').count).toBe(1)
    expect(report.notes.join(' ')).toMatch(/1 request\(s\) have no route template/)
  })

  test('totals cover every record', () => {
    const report = json(['analyze', writeLog([rec(), rec({ route: '/a' }), rec({ method: 'POST', route: '/a' })])])
    expect(report.totals.count).toBe(3)
    expect(report.groupsTotal).toBe(3)
  })
})

describe('analyze: input handling', () => {
  test('skips and counts lines that are not valid records; accepts records wrapped by another logger', () => {
    const lines = [
      'plain text from another logger',
      '{"level":30,"msg":"server started"}',
      JSON.stringify(rec({ schemaVersion: 2 })),
      JSON.stringify(rec({ durationMs: -1 })),
      JSON.stringify(rec({ status: 999 })),
      JSON.stringify(rec({ termination: 'aborted' })),
      JSON.stringify(rec({ timestamp: 'yesterday' })),
      JSON.stringify(rec({ requestId: 'x'.repeat(10) + 'y'.repeat(70 * 1024) })),
      '[1,2,3]',
      '',
      JSON.stringify({ level: 30, time: 1, pid: 1, hostname: 'h', ...rec() }),
      JSON.stringify(rec())
    ]
    const report = json(['analyze', writeLog(lines)])
    expect(report.input.records).toBe(2)
    expect(report.input.skipped).toEqual({
      notJson: 1,
      notRecord: 2,
      unsupportedSchema: 1,
      invalid: 4,
      outsideWindow: 0,
      tooLong: 1
    })
    expect(report.input.linesRead).toBe(11)
  })

  test('CRLF line endings are handled', () => {
    const report = json(['analyze', writeLog([rec(), rec()], '\r\n')])
    expect(report.input).toMatchObject({ records: 2, skippedTotal: 0 })
  })

  test('reads stdin with -', () => {
    const input = [rec(), rec()].map((r) => JSON.stringify(r)).join('\n') + '\n'
    const report = json(['analyze', '-'], input)
    expect(report.input.records).toBe(2)
  })

  test('merges several files', () => {
    const report = json(['analyze', writeLog([rec()]), writeLog([rec(), rec()])])
    expect(report.totals.count).toBe(3)
  })

  test('--since and --until filter by timestamp and are reported', () => {
    const lines = [
      rec({ timestamp: '2026-10-14T07:59:59.999Z' }),
      rec({ timestamp: '2026-10-14T08:00:00.000Z' }),
      rec({ timestamp: '2026-10-14T08:30:00.000Z' }),
      rec({ timestamp: '2026-10-14T09:00:00.001Z' })
    ]
    const report = json(['analyze', '--since', '2026-10-14T08:00:00Z', '--until', '2026-10-14T09:00:00Z', writeLog(lines)])
    expect(report.input.records).toBe(2)
    expect(report.input.skipped.outsideWindow).toBe(2)
    expect(report.window).toMatchObject({ first: '2026-10-14T08:00:00.000Z', last: '2026-10-14T08:30:00.000Z' })
  })
})

describe('analyze: grouping, sorting and slowest requests', () => {
  test('--by service and --by release; mixing them without grouping produces a note', () => {
    const lines = [rec({ release: '1.0.0' }), rec({ release: '1.0.1' }), rec({ release: '1.0.1', service: 'other-api' })]
    const byRoute = json(['analyze', writeLog(lines)])
    expect(byRoute.notes.join(' ')).toMatch(/2 services are mixed/)
    expect(byRoute.notes.join(' ')).toMatch(/2 releases are mixed/)

    const byRelease = json(['analyze', '--by', 'release', writeLog(lines)])
    expect(byRelease.groups.map((g) => [g.key, g.count])).toEqual([['1.0.1', 2], ['1.0.0', 1]])
    expect(byRelease.notes.join(' ')).not.toMatch(/releases are mixed/)

    const byService = json(['analyze', '--by', 'service', writeLog([rec({ service: null }), rec()])])
    expect(byService.groups.map((g) => g.key).sort()).toEqual(['(not set)', 'synthetic-api'])
  })

  test('--sort p95 orders by latency and --top limits groups', () => {
    const lines = []
    for (const [route, d] of [['/fast', 1], ['/slow', 50], ['/medium', 10]]) {
      for (let i = 0; i < 20; i++) lines.push(rec({ route, durationMs: d }))
    }
    lines.push(...Array.from({ length: 30 }, () => rec({ route: '/busy', durationMs: 5 })))
    const report = json(['analyze', '--sort', 'p95', '--top', '2', writeLog(lines)])
    expect(report.groups.map((g) => g.key)).toEqual(['GET /slow', 'GET /medium'])
    expect(report.groupsTotal).toBe(4)
    expect(report.notes.join(' ')).toMatch(/Showing 2 of 4 groups/)
  })

  test('--slowest lists the slowest finished requests with their IDs, slowest first', () => {
    const lines = [
      rec({ requestId: 'mid', durationMs: 20 }),
      rec({ requestId: 'slowest', durationMs: 90 }),
      rec({ requestId: 'aborted', termination: 'interrupted', status: null, headerDurationMs: null, durationMs: 500 }),
      rec({ requestId: 'fast', durationMs: 1 }),
      rec({ requestId: 'second', durationMs: 60 })
    ]
    const report = json(['analyze', '--slowest', '3', writeLog(lines)])
    expect(report.slowest.map((s) => s.requestId)).toEqual(['slowest', 'second', 'mid'])
  })
})

describe('analyze: optional eventLoopDelayMs (ADR-0009)', () => {
  test('is aggregated per group with a blocked count, and produces a note', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => rec({ eventLoopDelayMs: i < 18 ? 2 : 90 })),
      rec({ termination: 'interrupted', status: null, headerDurationMs: null, durationMs: 5, eventLoopDelayMs: 120 })
    ]
    const report = json(['analyze', writeLog(lines)])
    const g = group(report, 'GET /users/:id')
    expect(g.eventLoopDelayMs).toMatchObject({ n: 21, max: 120, blocked: 3 })
    expect(report.notes.join(' ')).toMatch(/3 request\(s\) saw the event loop blocked for 50 ms or more/)
  })

  test('absent field: no statistics, no note, no table column', () => {
    const report = json(['analyze', writeLog([rec(), rec()])])
    expect(report.totals.eventLoopDelayMs).toBeNull()
    expect(report.notes.join(' ')).not.toMatch(/event loop/)
    const { stdout } = cli(['analyze', writeLog([rec()])])
    expect(stdout).not.toMatch(/LOOP MAX MS/)
  })

  test('present field: the table gets a LOOP MAX MS column', () => {
    const { stdout } = cli(['analyze', writeLog([rec({ eventLoopDelayMs: 75.5 })])])
    expect(stdout).toMatch(/LOOP MAX MS/)
    expect(stdout).toMatch(/75\.5\s*$/m)
  })

  test('an invalid eventLoopDelayMs makes the record invalid', () => {
    const report = json(['analyze', writeLog([rec({ eventLoopDelayMs: -3 }), rec({ eventLoopDelayMs: 'slow' }), rec({ eventLoopDelayMs: null }), rec()])])
    expect(report.input.records).toBe(2)
    expect(report.input.skipped.invalid).toBe(2)
  })
})

describe('analyze: data quality and coverage (ADR-0004 addendum)', () => {
  function writeRaw (content) {
    const file = path.join(tmp, `raw-${++fileCounter}.jsonl`)
    fs.writeFileSync(file, content)
    return file
  }

  test('a truncated last line is reported as such; a bad line in the middle is not', () => {
    const full = JSON.stringify(rec())
    const cut = json(['analyze', writeRaw(`${full}\n${full}\n${full.slice(0, 70)}`)])
    expect(cut.input).toMatchObject({ records: 2, lastLineIncomplete: true })
    expect(cut.input.skipped.notJson).toBe(1)
    expect(cut.notes.some((n) => n.startsWith('The last line is not valid JSON.'))).toBe(true)

    const middle = json(['analyze', writeRaw(`${full}\n${full.slice(0, 70)}\n${full}\n\n`)])
    expect(middle.input).toMatchObject({ records: 2, lastLineIncomplete: false })
    expect(middle.input.skipped.notJson).toBe(1)
    expect(middle.notes.some((n) => n.startsWith('The last line'))).toBe(false)
  })

  test('a UTF-8 byte order mark before the first record is accepted', () => {
    const report = json(['analyze', writeRaw(`﻿${JSON.stringify(rec())}\n${JSON.stringify(rec())}\n`)])
    expect(report.input).toMatchObject({ records: 2, skippedTotal: 0, suspectUtf16: false })
  })

  test('a UTF-16 file fails with a hint instead of a bare "no records"', () => {
    const text = `${JSON.stringify(rec())}\r\n${JSON.stringify(rec())}\r\n`
    const file = writeRaw(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    const { status, stderr } = cli(['analyze', file])
    expect(status).toBe(1)
    expect(stderr).toMatch(/no express-observe records found/)
    expect(stderr).toMatch(/may be UTF-16, convert it to UTF-8/)
  })

  test('UTF-16 fragments next to valid records produce a note', () => {
    const fragment = Buffer.from(JSON.stringify(rec()), 'utf16le')
    const file = writeRaw(Buffer.concat([Buffer.from(`${JSON.stringify(rec())}\n`), fragment, Buffer.from(`\n${JSON.stringify(rec())}\n`)]))
    const report = json(['analyze', file])
    expect(report.input).toMatchObject({ records: 2, suspectUtf16: true })
    expect(report.notes.some((n) => n.includes('may be UTF-16'))).toBe(true)
  })

  test('records with another schemaVersion are skipped with a note that says which version is read', () => {
    const report = json(['analyze', writeLog([rec(), rec({ schemaVersion: 2 }), rec({ schemaVersion: 2 })])])
    expect(report.input).toMatchObject({ records: 1 })
    expect(report.input.skipped.unsupportedSchema).toBe(2)
    expect(report.notes).toContain('2 record(s) have a schemaVersion this analyze does not read (it reads 1). Use the analyze from the express-observe version that wrote them.')
  })

  test('records with malformed fields are skipped with their own note', () => {
    const report = json(['analyze', writeLog([rec(), rec({ durationMs: 'fast' })])])
    expect(report.input.skipped.invalid).toBe(1)
    expect(report.notes.some((n) => n.startsWith('1 record(s) look like express-observe records but have missing or malformed fields.'))).toBe(true)
  })

  test('the report states its method and that it covers this input only', () => {
    const report = json(['analyze', writeLog([rec()])])
    expect(report.reportVersion).toBe(1)
    expect(report.method).toEqual({ quantiles: 'nearest-rank', minSamples: { p95: 20, p99: 100 }, latency: 'finished-only' })
    expect(report.notes.some((n) => n.startsWith('This report describes the records in this input only.'))).toBe(true)

    const { stdout } = cli(['analyze', writeLog([rec()])])
    expect(stdout).toMatch(/^scope: {4}records in this input only; sampling or loss before it is unknown$/m)
    expect(stdout).toMatch(/nearest-rank percentiles; p95 needs 20 and p99 needs 100 values/)
  })

  test('interrupted requests do not make a group look slow: their durations stay out, and a note says so', () => {
    // 20 requests finished in 10 ms; 20 more were cut off after 500 ms. Latency describes the 20 that finished.
    const lines = [
      ...Array.from({ length: 20 }, () => rec({ durationMs: 10 })),
      ...Array.from({ length: 20 }, () => rec({ durationMs: 500, status: null, headerDurationMs: null, termination: 'interrupted' }))
    ]
    const report = json(['analyze', writeLog(lines)])
    const g = group(report, 'GET /users/:id')
    expect(g).toMatchObject({ count: 40, finished: 20, interrupted: 20, interruptedRate: 0.5 })
    expect(g.durationMs).toMatchObject({ n: 20, p95: 10, max: 10 })
    expect(report.notes.some((n) => n.includes('can look faster than its clients experienced it'))).toBe(true)
  })

  test('a filtered log gives filtered rates, and the report says it cannot correct for that', () => {
    // The review's arithmetic counter-example: 1000 requests, 100 of them 5xx. A pipeline keeps every error and
    // 90 of the 900 successes. The true 5xx rate is 10%; the retained file says 100 / 190.
    const lines = [
      ...Array.from({ length: 100 }, () => rec({ status: 503 })),
      ...Array.from({ length: 90 }, () => rec({ status: 200 }))
    ]
    const report = json(['analyze', writeLog(lines)])
    expect(report.totals.errorRate5xx).toBe(0.526)
    expect(report.notes.some((n) => n.includes('counts and rates are not totals for all traffic'))).toBe(true)
  })
})

describe('analyze: --by field:<name> (ADR-0011)', () => {
  const feed = (pageBucket, durationMs) => rec({ route: '/feed', pageBucket, durationMs })

  test('splits each METHOD route by the field, and reports the field in JSON and in the table header', () => {
    const lines = [
      ...Array.from({ length: 20 }, () => feed('1', 10)),
      ...Array.from({ length: 20 }, () => feed('>100', 400)),
      rec({ route: '/users/:id' })
    ]
    const report = json(['analyze', '--by', 'field:pageBucket', writeLog(lines)])
    expect(report.groupBy).toBe('field:pageBucket')
    expect(report.groupField).toEqual({ name: 'pageBucket', distinctValues: 2, capped: false, missing: 1 })
    expect(group(report, 'GET /feed  pageBucket=1').durationMs).toMatchObject({ n: 20, p95: 10 })
    expect(group(report, 'GET /feed  pageBucket=>100').durationMs).toMatchObject({ n: 20, p95: 400 })
    expect(group(report, 'GET /users/:id  pageBucket=(not set)').count).toBe(1)
    expect(report.notes).toContain('1 record(s) have no "pageBucket" field and are grouped as pageBucket=(not set). log.extend may not set it on every route.')
    expect(report.notes.some((n) => n.startsWith('Groups are split by "pageBucket"'))).toBe(true)

    const { status, stdout } = cli(['analyze', '--by', 'field:pageBucket', writeLog(lines)])
    expect(status).toBe(0)
    expect(stdout).toMatch(/^METHOD-ROUTE \/ pageBucket\s+COUNT/m)
    expect(stdout).toMatch(/GET \/feed {2}pageBucket=>100\s+20/)
  })

  test('without field grouping the report has groupField: null and is otherwise unchanged', () => {
    const report = json(['analyze', writeLog([feed('1', 10)])])
    expect(report.groupField).toBeNull()
    expect(report.groups.map((g) => g.key)).toEqual(['GET /feed'])
  })

  test('caps the number of distinct values; the rest are grouped together with a note', () => {
    const lines = Array.from({ length: 60 }, (_, i) => rec({ route: '/feed', page: i + 1 }))
    const report = json(['analyze', '--by', 'field:page', '--top', '0', writeLog(lines)])
    expect(report.groupField).toMatchObject({ distinctValues: 50, capped: true })
    expect(report.groups).toHaveLength(51)
    expect(group(report, 'GET /feed  page=(other values)').count).toBe(10)
    expect(report.notes.some((n) => n.startsWith('"page" has more than 50 distinct values, so it is probably high-cardinality'))).toBe(true)
  })

  test('non-scalar values, long values and inherited property names are handled safely', () => {
    const lines = [
      rec({ tag: { nested: true } }),
      rec({ tag: ['a'] }),
      rec({ tag: 'x'.repeat(100) }),
      rec({ tag: true }),
      rec()
    ]
    const report = json(['analyze', '--by', 'field:tag', writeLog(lines)])
    const keys = report.groups.map((g) => g.key)
    expect(keys).toContain('GET /users/:id  tag=(not a scalar)')
    expect(keys).toContain(`GET /users/:id  tag=${'x'.repeat(64)}`)
    expect(keys).toContain('GET /users/:id  tag=true')
    expect(group(report, 'GET /users/:id  tag=(not a scalar)').count).toBe(2)

    const inherited = json(['analyze', '--by', 'field:constructor', writeLog([rec()])])
    expect(inherited.groups.map((g) => g.key)).toEqual(['GET /users/:id  constructor=(not set)'])
  })

  test.each([
    ['field:durationMs', /core record field/],
    ['field:requestId', /core record field/],
    ['field:', /field name/],
    ['field:page-bucket', /field name/],
    ['field:a.b', /field name/],
    ['pageBucket', /--by must be one of/]
  ])('--by %s is a usage error (exit 2)', (by, message) => {
    const { status, stderr } = cli(['analyze', '--by', by, writeLog([rec()])])
    expect(status).toBe(2)
    expect(stderr).toMatch(message)
  })

  test('end to end: log.extend adds a coarse bucket, analyze splits the route by it', async () => {
    const file = path.join(tmp, `e2e-field-${++fileCounter}.jsonl`)
    const lines = []
    const bucket = (page) => (page <= 1 ? '1' : page <= 10 ? '2-10' : '>10')
    const app = express()
    app.use(observe({
      log: {
        sink: (record) => { lines.push(JSON.stringify(record)) },
        extend: (req) => (req.path === '/feed' ? { pageBucket: bucket(Number(req.query.page) || 1) } : null)
      }
    }))
    app.get('/feed', (req, res) => res.json({ ok: true }))
    for (const page of [1, 1, 5, 50]) await request(app).get(`/feed?page=${page}`).expect(200)
    await waitForLines(lines, 4)
    fs.writeFileSync(file, lines.join('\n') + '\n')

    const report = json(['analyze', '--by', 'field:pageBucket', file])
    expect(Object.fromEntries(report.groups.map((g) => [g.key, g.count]))).toEqual({
      'GET /feed  pageBucket=1': 2,
      'GET /feed  pageBucket=2-10': 1,
      'GET /feed  pageBucket=>10': 1
    })
    // The page numbers themselves never reach the log, only the bucket.
    for (const record of lines.map((l) => JSON.parse(l))) {
      expect(Object.keys(record)).not.toContain('page')
      expect(Object.values(record)).not.toContain('50')
      expect(JSON.stringify(record)).not.toContain('page=')
    }
  })
})

async function waitForLines (lines, count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (lines.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} lines, got ${lines.length}`)
    await sleep(5)
  }
}

describe('analyze: text output', () => {
  test('prints a table with a totals row and notes', () => {
    const lines = Array.from({ length: 25 }, (_, i) => rec({ durationMs: i + 1 }))
    const { status, stdout } = cli(['analyze', writeLog(lines)])
    expect(status).toBe(0)
    expect(stdout).toMatch(/^express-observe analyze: 25 records from /)
    expect(stdout).toMatch(/GET \/users\/:id\s+25\s+0\.0%\s+0\s+13\.0\s+24\.0\s+-\s+25\.0/)
    expect(stdout).toMatch(/all requests\s+25/)
    expect(stdout).toMatch(/Notes:/)
  })

  test('strings from the log cannot inject terminal escape sequences', () => {
    const lines = [rec({ route: '/x\u001b[31mRED\u001b[0m', service: 'svc\u0007', requestId: 'id\u001b]0;title\u0007' })]
    const { status, stdout } = cli(['analyze', '--slowest', '1', writeLog(lines)])
    expect(status).toBe(0)
    expect(stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    expect(stdout).toContain('/x?[31mRED?[0m')
  })
})

describe('analyze: exit codes and usage', () => {
  test('no valid records: exit 1 with a message', () => {
    const { status, stderr, stdout } = cli(['analyze', writeLog(['nothing here'])])
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/no express-observe records found/)
  })

  test('missing file: exit 1', () => {
    const { status, stderr } = cli(['analyze', path.join(tmp, 'does-not-exist.log')])
    expect(status).toBe(1)
    expect(stderr).toMatch(/no such file/)
  })

  test.each([
    [['analyze']],
    [['analyze', '--by', 'user', 'x.log']],
    [['analyze', '--sort', 'name', 'x.log']],
    [['analyze', '--top', '-1', 'x.log']],
    [['analyze', '--slowest', '101', 'x.log']],
    [['analyze', '--since', 'last week', 'x.log']],
    [['analyze', '--since', '2026-10-15', '--until', '2026-10-14', 'x.log']],
    [['analyze', '--color', 'x.log']],
    [['analyze', '-', '-']],
    [['frobnicate']]
  ])('usage error %j: exit 2', (args) => {
    const { status, stderr } = cli(args)
    expect(status).toBe(2)
    expect(stderr.length).toBeGreaterThan(0)
  })

  test('--help and --version exit 0', () => {
    expect(cli(['analyze', '--help'])).toMatchObject({ status: 0, stdout: expect.stringMatching(/^Usage: express-observe analyze/) })
    expect(cli(['--version']).stdout.trim()).toBe(require('../package.json').version)
  })
})

describe('analyze: end to end with the real middleware', () => {
  test('records written by observe() are read back with the expected groups', async () => {
    const file = path.join(tmp, 'e2e.jsonl')
    const out = fs.createWriteStream(file)
    const app = express()
    app.use(observe({ service: 'e2e-api', log: { sink: (r) => out.write(JSON.stringify(r) + '\n') } }))
    app.get('/users/:id', (req, res) => res.json({ ok: true }))
    app.get('/boom', (req, res, next) => next(new Error('synthetic')))
    app.get('/hang', () => {})
    app.use((err, req, res, _next) => res.status(500).json({ error: 'internal' }))

    for (let i = 0; i < 25; i++) await request(app).get(`/users/${i}`)
    await request(app).get('/boom')
    await request(app).get('/missing')

    const { port, close } = await listen(app)
    const socket = net.connect(port, '127.0.0.1')
    socket.on('error', () => {})
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write('GET /hang HTTP/1.1\r\nHost: localhost\r\n\r\n')
    await sleep(30)
    socket.destroy()
    await sleep(100)
    await close()
    await new Promise((resolve) => out.end(resolve))

    const report = json(['analyze', '--top', '0', file])
    expect(report.input).toMatchObject({ records: 28, skippedTotal: 0 })
    expect(report.services).toEqual(['e2e-api'])
    expect(group(report, 'GET /users/:id')).toMatchObject({ count: 25, finished: 25 })
    expect(group(report, 'GET /users/:id').durationMs.p95).not.toBeNull()
    expect(group(report, 'GET /boom')).toMatchObject({ count: 1, errorRate5xx: 1 })
    expect(group(report, 'GET (unknown route)')).toMatchObject({ count: 1 })
    expect(group(report, 'GET /hang')).toMatchObject({ count: 1, interrupted: 1, finished: 0 })
    expect(group(report, 'GET /hang').durationMs.p50).toBeNull()
  })
})
