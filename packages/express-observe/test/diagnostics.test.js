'use strict'

// getDiagnostics() (ADR-0010). Counters are process-wide and shared by every test in this file, so each test
// works with the difference between a snapshot taken before and one taken after.

const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const express = require('express')
const request = require('supertest')
const observe = require('../src')
const { listen, sleep } = require('./helpers/http')

const { getDiagnostics } = observe

const SNAPSHOT_KEYS = ['schemaVersion', 'pid', 'threadId', 'since', 'requests', 'records', 'warnings']
const REQUEST_KEYS = ['started', 'finished', 'interrupted', 'inFlight']
const RECORD_KEYS = ['emitted', 'dropped', 'sinkErrors', 'sinkPending']

function flatten (snapshot) {
  return { ...snapshot.requests, ...snapshot.records, warnings: snapshot.warnings }
}

function diff (before, after) {
  const a = flatten(before)
  const b = flatten(after)
  return Object.fromEntries(Object.keys(a).map((key) => [key, b[key] - a[key]]))
}

/** Poll until predicate(snapshot) holds. Counters move on the server's 'finish'/'close', after the client is done. */
async function waitForDiagnostics (predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = getDiagnostics()
    if (predicate(snapshot)) return snapshot
    if (Date.now() > deadline) throw new Error(`diagnostics condition not met: ${JSON.stringify(snapshot)}`)
    await sleep(5)
  }
}

function captureStderr () {
  const lines = []
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk))
    return true
  })
  return { lines, restore: () => spy.mockRestore() }
}

function quietSink () {}

describe('getDiagnostics(): snapshot', () => {
  test('is exported both as a property and by name, with a fixed shape that says where it came from', () => {
    expect(require('../src').getDiagnostics).toBe(getDiagnostics)

    const snapshot = getDiagnostics()
    expect(Object.keys(snapshot)).toEqual(SNAPSHOT_KEYS)
    expect(Object.keys(snapshot.requests)).toEqual(REQUEST_KEYS)
    expect(Object.keys(snapshot.records)).toEqual(RECORD_KEYS)
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.pid).toBe(process.pid)
    expect(snapshot.threadId).toBe(require('node:worker_threads').threadId)
    expect(snapshot.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Date.parse(snapshot.since)).toBeLessThanOrEqual(Date.now())
    for (const value of Object.values(flatten(snapshot))) expect(Number.isInteger(value)).toBe(true)
  })

  test('returns a new object each time; changing it does not change the counters', () => {
    const first = getDiagnostics()
    first.requests.started = -1
    first.records.emitted = -1
    const second = getDiagnostics()
    expect(second).not.toBe(first)
    expect(second.requests.started).toBeGreaterThanOrEqual(0)
    expect(second.records.emitted).toBeGreaterThanOrEqual(0)
  })
})

describe('getDiagnostics(): requests and records', () => {
  test('completed requests: started, finished and emitted agree, nothing is left in flight', async () => {
    const app = express()
    app.use(observe({ log: { sink: quietSink } }))
    app.get('/items/:id', (req, res) => res.send('ok'))

    const before = getDiagnostics()
    for (let i = 0; i < 25; i++) await request(app).get(`/items/${i}?q=${i}`).expect(200)
    const after = await waitForDiagnostics((s) => s.records.emitted - before.records.emitted >= 25)

    expect(diff(before, after)).toEqual({
      started: 25, finished: 25, interrupted: 0, inFlight: 0, emitted: 25, dropped: 0, sinkErrors: 0, sinkPending: 0, warnings: 0
    })
    // Distinct paths do not add counters: the shape is fixed.
    expect(Object.keys(after.requests)).toEqual(REQUEST_KEYS)
    expect(Object.keys(after.records)).toEqual(RECORD_KEYS)
  })

  test('inFlight counts a request whose handler has not responded yet', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let entered
    const handlerEntered = new Promise((resolve) => { entered = resolve })
    const app = express()
    app.use(observe({ log: { sink: quietSink } }))
    app.get('/slow', async (req, res) => {
      entered()
      await gate
      res.send('done')
    })

    const before = getDiagnostics()
    const pending = request(app).get('/slow').then((res) => res)
    await handlerEntered
    const during = getDiagnostics()
    expect(diff(before, during)).toMatchObject({ started: 1, finished: 0, inFlight: 1, emitted: 0 })

    release()
    expect((await pending).status).toBe(200)
    const after = await waitForDiagnostics((s) => s.requests.finished - before.requests.finished >= 1)
    expect(diff(before, after)).toMatchObject({ started: 1, finished: 1, inFlight: 0, emitted: 1 })
  })

  test('a client that disconnects is counted as interrupted, with its record emitted', async () => {
    const records = []
    let entered
    const handlerEntered = new Promise((resolve) => { entered = resolve })
    const app = express()
    app.use(observe({ log: { sink: (record) => { records.push(record) } } }))
    app.get('/never', () => { entered() })
    const { port, close } = await listen(app)

    try {
      const before = getDiagnostics()
      const socket = net.connect(port, '127.0.0.1')
      socket.on('error', () => {})
      await new Promise((resolve) => socket.once('connect', resolve))
      socket.write('GET /never HTTP/1.1\r\nHost: localhost\r\n\r\n')
      await handlerEntered
      socket.destroy()

      const after = await waitForDiagnostics((s) => s.requests.interrupted - before.requests.interrupted >= 1)
      expect(diff(before, after)).toMatchObject({ started: 1, finished: 0, interrupted: 1, inFlight: 0, emitted: 1 })
      expect(records.map((r) => r.termination)).toEqual(['interrupted'])
    } finally {
      await close()
    }
  })

  test('a second observe() instance on the same request does not count it twice', async () => {
    const app = express()
    app.use(observe({ log: { sink: quietSink } }))
    app.use(observe({ log: { sink: quietSink } }))
    app.get('/', (req, res) => res.send('ok'))

    const before = getDiagnostics()
    await request(app).get('/').expect(200)
    const after = await waitForDiagnostics((s) => s.requests.finished - before.requests.finished >= 1)
    await sleep(20)
    expect(diff(before, getDiagnostics())).toMatchObject({ started: 1, finished: 1, emitted: 1 })
    expect(after.requests.inFlight).toBe(before.requests.inFlight)
  })

  test('with logging disabled, requests are still counted and record counters do not move', async () => {
    const app = express()
    app.use(observe({ log: { enabled: false } }))
    app.get('/', (req, res) => res.send('ok'))

    const before = getDiagnostics()
    for (let i = 0; i < 3; i++) await request(app).get('/').expect(200)
    const after = await waitForDiagnostics((s) => s.requests.finished - before.requests.finished >= 3)
    expect(diff(before, after)).toEqual({
      started: 3, finished: 3, interrupted: 0, inFlight: 0, emitted: 0, dropped: 0, sinkErrors: 0, sinkPending: 0, warnings: 0
    })
  })

  test('instances in different apps of one process add up', async () => {
    const appA = express()
    appA.use(observe({ service: 'a', log: { sink: quietSink } }))
    appA.get('/', (req, res) => res.send('a'))
    const appB = express()
    appB.use(observe({ service: 'b', log: { sink: quietSink } }))
    appB.get('/', (req, res) => res.send('b'))

    const before = getDiagnostics()
    await request(appA).get('/').expect(200)
    await request(appB).get('/').expect(200)
    const after = await waitForDiagnostics((s) => s.records.emitted - before.records.emitted >= 2)
    expect(diff(before, after)).toMatchObject({ started: 2, finished: 2, emitted: 2 })
  })
})

describe('getDiagnostics(): failures stay visible and the response is intact', () => {
  test('a throwing sink: response unchanged, record counted as emitted and as a sink error', async () => {
    const errors = []
    const app = express()
    app.use(observe({
      log: {
        sink: () => { throw new Error('sink down') },
        onSinkError: (err) => { errors.push(err) }
      }
    }))
    app.get('/', (req, res) => res.send('ok'))

    const before = getDiagnostics()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
    const after = await waitForDiagnostics((s) => s.records.sinkErrors - before.records.sinkErrors >= 1)
    expect(diff(before, after)).toMatchObject({ finished: 1, emitted: 1, dropped: 0, sinkErrors: 1, sinkPending: 0 })
    expect(errors).toHaveLength(1)
  })

  test('an async sink: pending while unsettled, back to zero after; a rejection is a sink error', async () => {
    const settlers = []
    const app = express()
    app.use(observe({
      log: {
        sink: () => new Promise((resolve, reject) => { settlers.push({ resolve, reject }) }),
        onSinkError: () => {}
      }
    }))
    app.get('/', (req, res) => res.send('ok'))

    const before = getDiagnostics()
    await request(app).get('/').expect(200)
    await request(app).get('/').expect(200)
    const during = await waitForDiagnostics((s) => s.records.emitted - before.records.emitted >= 2)
    expect(diff(before, during)).toMatchObject({ emitted: 2, sinkPending: 2, sinkErrors: 0 })

    settlers[0].resolve()
    settlers[1].reject(new Error('remote refused'))
    const after = await waitForDiagnostics((s) => s.records.sinkPending === before.records.sinkPending)
    expect(diff(before, after)).toMatchObject({ emitted: 2, sinkPending: 0, sinkErrors: 1 })
  })

  test('a thenable that calls back twice is settled once', async () => {
    const app = express()
    app.use(observe({
      log: {
        sink: () => ({ then (onFulfilled, onRejected) { onRejected(new Error('first')); onRejected(new Error('again')); onFulfilled() } }),
        onSinkError: () => {}
      }
    }))
    app.get('/', (req, res) => res.send('ok'))

    const before = getDiagnostics()
    await request(app).get('/').expect(200)
    const after = await waitForDiagnostics((s) => s.records.emitted - before.records.emitted >= 1)
    expect(diff(before, after)).toMatchObject({ emitted: 1, sinkErrors: 1, sinkPending: 0 })
  })

  test('a record that cannot be built is counted as dropped; the response is unaffected', async () => {
    const stderr = captureStderr()
    const sinkCalls = []
    try {
      const app = express()
      app.use(observe({ log: { sink: (record) => { sinkCalls.push(record) } } }))
      app.get('/', (req, res) => {
        res.send('ok')
        // Breaks reading the status when the record is built, after the response has been written.
        Object.defineProperty(res, 'statusCode', { configurable: true, get () { throw new Error('synthetic') } })
      })

      const before = getDiagnostics()
      const res = await request(app).get('/')
      expect(res.status).toBe(200)
      expect(res.text).toBe('ok')
      const after = await waitForDiagnostics((s) => s.records.dropped - before.records.dropped >= 1)
      expect(diff(before, after)).toMatchObject({ finished: 1, inFlight: 0, emitted: 0, dropped: 1, warnings: 1 })
      expect(sinkCalls).toHaveLength(0)
      expect(stderr.lines.join('')).toContain('record dropped')
      expect(stderr.lines.join('')).not.toContain('synthetic')
    } finally {
      stderr.restore()
    }
  })

  test('warnings counts every warning, including the ones whose stderr line was rate-limited', async () => {
    const stderr = captureStderr()
    try {
      const app = express()
      app.use(observe({ log: { sink: () => { throw new Error('down') } } }))
      app.get('/', (req, res) => res.send('ok'))

      const before = getDiagnostics()
      for (let i = 0; i < 3; i++) await request(app).get('/').expect(200)
      const after = await waitForDiagnostics((s) => s.warnings - before.warnings >= 3)
      expect(diff(before, after)).toMatchObject({ emitted: 3, sinkErrors: 3, warnings: 3 })
      expect(stderr.lines.filter((line) => line.startsWith('express-observe:'))).toHaveLength(1)
    } finally {
      stderr.restore()
    }
  })

  test('the invariant finished + interrupted = emitted + dropped holds across a mixed run', async () => {
    const stderr = captureStderr()
    const app = express()
    app.use(observe({ log: { sink: quietSink } }))
    app.get('/ok', (req, res) => res.send('ok'))
    app.get('/broken', (req, res) => {
      res.send('ok')
      Object.defineProperty(res, 'statusCode', { configurable: true, get () { throw new Error('synthetic') } })
    })
    let entered
    const handlerEntered = new Promise((resolve) => { entered = resolve })
    app.get('/never', () => { entered() })
    const { port, close } = await listen(app)

    try {
      const before = getDiagnostics()
      for (let i = 0; i < 5; i++) await request(app).get('/ok').expect(200)
      await request(app).get('/broken').expect(200)
      const socket = net.connect(port, '127.0.0.1')
      socket.on('error', () => {})
      await new Promise((resolve) => socket.once('connect', resolve))
      socket.write('GET /never HTTP/1.1\r\nHost: localhost\r\n\r\n')
      await handlerEntered
      socket.destroy()

      const after = await waitForDiagnostics((s) => s.requests.started - before.requests.started === 7 && s.requests.inFlight === before.requests.inFlight)
      const d = diff(before, after)
      expect(d).toMatchObject({ started: 7, finished: 6, interrupted: 1, emitted: 6, dropped: 1 })
      expect(d.finished + d.interrupted).toBe(d.emitted + d.dropped)
    } finally {
      await close()
      stderr.restore()
    }
  })
})

describe('getDiagnostics(): scope and side effects', () => {
  test('a worker thread has its own counters, which say which thread they belong to', async () => {
    const before = getDiagnostics()
    const workerSnapshot = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'fixtures', 'diagnostics-worker.js'), {
        workerData: { packagePath: path.join(__dirname, '..', 'src') }
      })
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with ${code}`)) })
    })

    expect(workerSnapshot.threadId).not.toBe(before.threadId)
    expect(workerSnapshot.pid).toBe(process.pid)
    expect(workerSnapshot.requests).toEqual({ started: 2, finished: 2, interrupted: 0, inFlight: 0 })
    expect(workerSnapshot.records.emitted).toBe(2)
    // The worker's requests are not in this thread's counters.
    expect(diff(before, getDiagnostics()).started).toBe(0)
  })

  test('loading the package and serving requests installs no process handlers and no timers', async () => {
    const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection', 'warning']
    const listenerCounts = () => EVENTS.map((event) => process.listenerCount(event))
    const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

    const listenersBefore = listenerCounts()
    let fresh
    jest.isolateModules(() => { fresh = require('../src') })
    const app = express()
    app.use(fresh({ log: { sink: quietSink } }))
    app.get('/', (req, res) => res.send('ok'))
    const { port, close } = await listen(app)
    try {
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }).on('error', reject)
      })
      expect(status).toBe(200)
      await waitForFresh(fresh, (s) => s.records.emitted === 1)
    } finally {
      await close()
    }
    const timersAfterServe = timers()
    fresh.getDiagnostics()

    expect(listenerCounts()).toEqual(listenersBefore)
    expect(timers()).toBe(timersAfterServe)
    expect(fresh.getDiagnostics().requests).toEqual({ started: 1, finished: 1, interrupted: 0, inFlight: 0 })
  })
})

async function waitForFresh (pkg, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate(pkg.getDiagnostics())) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(pkg.getDiagnostics())}`)
    await sleep(5)
  }
}
