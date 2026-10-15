'use strict'

const express = require('express')
const request = require('supertest')
const { Worker } = require('node:worker_threads')
const observe = require('../src')
const { listen, sleep } = require('./helpers/http')
const { collectingSink, RECORD_KEYS } = require('./helpers/records')

const BLOCK_MS = 120
// For the two tests where a request from another thread must arrive during the block, the block is long and
// the request is aimed at its middle, so slow CI runners (shared cores, parallel Jest workers) still land inside it.
const LATE_BLOCK_MS = 400
const LATE_REQUEST_AT_MS = 150

function burn (ms) {
  const end = process.hrtime.bigint() + BigInt(ms * 1e6)
  while (process.hrtime.bigint() < end) { /* busy */ }
}

/** Send one GET from a worker thread, `delayMs` after `go()`. The worker's event loop is independent of ours. */
async function workerGet (port, path, delayMs) {
  const code = `
    const http = require('node:http')
    const { parentPort, workerData } = require('node:worker_threads')
    parentPort.once('message', () => setTimeout(() => {
      http.get({ host: '127.0.0.1', port: workerData.port, path: workerData.path, agent: false }, (res) => {
        res.resume()
        res.on('end', () => parentPort.postMessage({ requestId: res.headers['x-request-id'] }))
      })
    }, workerData.delayMs))
    parentPort.postMessage({ ready: true })
  `
  const worker = new Worker(code, { eval: true, workerData: { port, path, delayMs } })
  await new Promise((resolve) => worker.once('message', resolve))
  const done = new Promise((resolve) => worker.once('message', (msg) => { resolve(msg); worker.terminate() }))
  return { go: () => worker.postMessage('go'), done }
}

function appWith (options, extra) {
  const collector = collectingSink()
  const app = express()
  app.use(observe({ ...options, log: { sink: collector.sink } }))
  app.get('/fast', (req, res) => res.send('ok'))
  if (extra) extra(app)
  return { app, ...collector }
}

describe('eventLoopDelayMs (ADR-0009)', () => {
  test('is absent by default', async () => {
    const { app, waitFor } = appWith({})
    await request(app).get('/fast')
    const [record] = await waitFor(1)
    expect(Object.keys(record)).toEqual(RECORD_KEYS)
  })

  test('when enabled, it sits after durationMs and stays small on a quiet process', async () => {
    const { app, waitFor } = appWith({ eventLoop: { enabled: true } })
    await request(app).get('/fast')
    await sleep(100)
    await request(app).get('/fast')
    const records = await waitFor(2)
    const keys = Object.keys(records[1])
    expect(keys.indexOf('eventLoopDelayMs')).toBe(keys.indexOf('durationMs') + 1)
    expect(records[1].eventLoopDelayMs).toBeGreaterThanOrEqual(0)
    expect(records[1].eventLoopDelayMs).toBeLessThan(50)
  })

  test('shows a block that happened while the request was in flight', async () => {
    // The server itself enforces the order (CI runners are too slow for sleeps to do it): /waits answers only
    // after /blocks has finished burning, so the block always falls inside /waits' lifetime.
    let arrived = null
    let release = null
    const waitsArrived = new Promise((resolve) => { arrived = resolve })
    const { app, waitFor } = appWith({ eventLoop: { enabled: true } }, (a) => {
      a.get('/waits', (req, res) => {
        release = () => res.send('done')
        arrived()
      })
      a.get('/blocks', (req, res) => {
        burn(BLOCK_MS)
        res.send('blocked')
        release()
      })
    })
    const { port, close } = await listen(app)
    try {
      await request(`http://127.0.0.1:${port}`).get('/fast') // starts the sampler
      // A supertest request is only sent when .then()/.end() is called, so call .then() now: the earlier version
      // of this test awaited it after the block and therefore sent it after the block, passing by luck locally.
      const waiting = request(`http://127.0.0.1:${port}`).get('/waits').then((res) => res)
      await waitsArrived
      await request(`http://127.0.0.1:${port}`).get('/blocks')
      const res = await waiting
      const records = await waitFor(3)
      const waitsRecord = records.find((r) => r.requestId === res.headers['x-request-id'])
      expect(waitsRecord.eventLoopDelayMs).toBeGreaterThanOrEqual(BLOCK_MS * 0.75)
    } finally {
      await close()
    }
  })

  test('shows a block that ended just before the request reached observe() (the L3 blind spot)', async () => {
    const { app, waitFor } = appWith({ eventLoop: { enabled: true } }, (a) => {
      // Answers at once, then blocks the event loop shortly afterwards; no request is in flight for it.
      a.get('/block-later', (req, res) => {
        setTimeout(() => burn(LATE_BLOCK_MS), 20)
        res.send('ok')
      })
    })
    const { port, close } = await listen(app)
    try {
      await request(`http://127.0.0.1:${port}`).get('/fast') // starts the sampler
      await sleep(60)
      const client = await workerGet(port, '/fast', LATE_REQUEST_AT_MS) // arrives while the loop is blocked
      await request(`http://127.0.0.1:${port}`).get('/block-later')
      client.go()
      const { requestId } = await client.done
      const records = await waitFor(3)
      const record = records.find((r) => r.requestId === requestId)
      expect(record.durationMs).toBeLessThan(LATE_BLOCK_MS * 0.25) // the wait is not in durationMs ...
      expect(record.eventLoopDelayMs).toBeGreaterThanOrEqual(LATE_BLOCK_MS * 0.5) // ... but the block is visible
    } finally {
      await close()
    }
  })

  test('shows a block from setImmediate work, whose sample lands just before the waiting request starts', async () => {
    const { app, waitFor } = appWith({ eventLoop: { enabled: true } }, (a) => {
      // Blocking in the check phase lets the sampler's tick run (timers phase) before the waiting request is
      // handled (poll phase), so only the look-back window finds the sample.
      a.get('/block-immediate', (req, res) => {
        setTimeout(() => setImmediate(() => burn(LATE_BLOCK_MS)), 20)
        res.send('ok')
      })
    })
    const { port, close } = await listen(app)
    try {
      await request(`http://127.0.0.1:${port}`).get('/fast')
      await sleep(60)
      const client = await workerGet(port, '/fast', LATE_REQUEST_AT_MS)
      await request(`http://127.0.0.1:${port}`).get('/block-immediate')
      client.go()
      const { requestId } = await client.done
      const records = await waitFor(3)
      const record = records.find((r) => r.requestId === requestId)
      expect(record.durationMs).toBeLessThan(LATE_BLOCK_MS * 0.25)
      expect(record.eventLoopDelayMs).toBeGreaterThanOrEqual(LATE_BLOCK_MS * 0.5)
    } finally {
      await close()
    }
  })

  test('is not added when logging is disabled, and the option is validated', () => {
    expect(() => observe({ eventLoop: { enabled: true }, log: { enabled: false } })).not.toThrow()
    for (const eventLoop of [{ enabled: 'yes' }, { resolutionMs: 1 }, { resolutionMs: 5000 }, { resolutionMs: 2.5 }, { interval: 10 }]) {
      expect(() => observe({ eventLoop })).toThrow(TypeError)
    }
  })
})
