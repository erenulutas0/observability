'use strict'

const http = require('node:http')
const net = require('node:net')
const express = require('express')
const request = require('supertest')
const observe = require('../src')
const { listen, sleep } = require('./helpers/http')
const { collectingSink, RECORD_KEYS } = require('./helpers/records')

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function setup (configure, options = {}) {
  const collector = collectingSink()
  const app = express()
  app.use(observe({ ...options, log: { ...options.log, sink: collector.sink } }))
  configure(app)
  return { app, ...collector }
}

/** Open a real TCP connection, send a request head, and destroy the socket after `afterMs`. */
async function abortAfter (port, path, afterMs) {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
  await sleep(afterMs)
  socket.destroy()
}

/** Read the first body chunk with Node's http client, then destroy the connection. */
function abortAfterFirstChunk (port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.once('data', () => {
        req.destroy()
        resolve(res.headers)
      })
    })
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err) })
  })
}

describe('access log: normal termination', () => {
  test('one record with the documented fields, types and values', async () => {
    const { app, waitFor, settle } = setup((a) => {
      a.get('/users/:id', (req, res) => res.json({ ok: true }))
    }, { service: 'synthetic-api', release: '0.0.1-test' })

    const res = await request(app).get('/users/42')
    const [record] = await waitFor(1)

    expect(Object.keys(record)).toEqual(RECORD_KEYS)
    expect(record).toMatchObject({
      schemaVersion: 1,
      requestId: res.headers['x-request-id'],
      requestIdSource: 'generated',
      service: 'synthetic-api',
      release: '0.0.1-test',
      method: 'GET',
      route: '/users/:id',
      status: 200,
      termination: 'finished'
    })
    expect(record.requestId).toMatch(UUID_V4)
    expect(record.timestamp).toMatch(ISO_8601)
    expect(typeof record.headerDurationMs).toBe('number')
    expect(record.headerDurationMs).toBeLessThanOrEqual(record.durationMs)
    expect(await settle()).toHaveLength(1)
  })

  test('service and release default to null', async () => {
    const { app, waitFor } = setup((a) => a.get('/', (req, res) => res.send('ok')))
    await request(app).get('/')
    const [record] = await waitFor(1)
    expect(record.service).toBeNull()
    expect(record.release).toBeNull()
  })

  test('finish followed by connection close still yields exactly one record', async () => {
    const { app, waitFor, settle } = setup((a) => a.get('/', (req, res) => res.send('ok')))
    const { port, close } = await listen(app)
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    try {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
            res.resume()
            res.on('end', resolve)
          }).on('error', reject)
        })
      }
      await waitFor(5)
      agent.destroy() // closes the kept-alive socket: every response now also sees 'close'
      const records = await settle(150)
      expect(records).toHaveLength(5)
      expect(new Set(records.map((r) => r.requestId)).size).toBe(5)
      expect(records.every((r) => r.termination === 'finished')).toBe(true)
    } finally {
      await close()
    }
  })

  test('200 concurrent requests produce 200 records whose IDs match the response headers', async () => {
    const { app, waitFor } = setup((a) => a.get('/', (req, res) => res.send('ok')))
    const { port, close } = await listen(app)
    const agent = new http.Agent({ keepAlive: true, maxSockets: 32 })
    try {
      const headerIds = await Promise.all(Array.from({ length: 200 }, () => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.headers['x-request-id']))
        }).on('error', reject)
      })))
      const records = await waitFor(200)
      expect(records).toHaveLength(200)
      expect(new Set(records.map((r) => r.requestId))).toEqual(new Set(headerIds))
    } finally {
      agent.destroy()
      await close()
    }
  })

  test('mounting observe() twice yields one record', async () => {
    const collector = collectingSink()
    const app = express()
    app.use(observe({ log: { sink: collector.sink } }))
    app.use(observe({ log: { sink: collector.sink } }))
    app.get('/', (req, res) => res.send('ok'))
    await request(app).get('/')
    await collector.waitFor(1)
    expect(await collector.settle()).toHaveLength(1)
  })

  test('log.enabled: false emits nothing', async () => {
    const sink = jest.fn()
    const app = express()
    app.use(observe({ log: { enabled: false, sink } }))
    app.get('/', (req, res) => res.send('ok'))
    await request(app).get('/')
    await sleep(50)
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('access log: errors and 404', () => {
  test('next(err) is logged as a finished 500 and the error still reaches the application error handler', async () => {
    const seen = []
    const { app, waitFor } = setup((a) => {
      a.get('/fail', (req, res, next) => next(new Error('synthetic failure')))
      a.use((err, req, res, _next) => {
        seen.push(err.message)
        res.status(500).json({ error: 'internal' })
      })
    })
    const res = await request(app).get('/fail')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'internal' })
    expect(seen).toEqual(['synthetic failure'])
    const [record] = await waitFor(1)
    expect(record).toMatchObject({ status: 500, termination: 'finished', route: '/fail' })
  })

  test("a synchronous throw handled by Express's default handler is logged once as 500", async () => {
    const { app, waitFor, settle } = setup((a) => {
      a.get('/throw', () => { throw new Error('synthetic failure') })
    })
    const res = await request(app).get('/throw')
    expect(res.status).toBe(500)
    const [record] = await waitFor(1)
    expect(record).toMatchObject({ status: 500, termination: 'finished', route: '/throw' })
    expect(await settle()).toHaveLength(1)
  })

  test('an unmatched URL is logged as 404 with route null', async () => {
    const { app, waitFor } = setup((a) => a.get('/known', (req, res) => res.send('ok')))
    const res = await request(app).get('/unknown/12345')
    expect(res.status).toBe(404)
    const [record] = await waitFor(1)
    expect(record).toMatchObject({ status: 404, route: null, termination: 'finished' })
  })

  test('a matched route that answers 404 keeps its route label', async () => {
    const { app, waitFor } = setup((a) => {
      a.get('/users/:id', (req, res) => res.status(404).json({ error: 'no such user' }))
    })
    await request(app).get('/users/999')
    const [record] = await waitFor(1)
    expect(record).toMatchObject({ status: 404, route: '/users/:id' })
  })

  test('next(err) after headers were sent: Express destroys the socket and the record says interrupted with the real status', async () => {
    const { app, waitFor, settle } = setup((a) => {
      a.get('/partial', (req, res, next) => {
        res.status(200)
        res.write('partial body')
        next(new Error('synthetic failure mid-stream'))
      })
    })
    const { port, close } = await listen(app)
    try {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/partial', agent: false }, (res) => {
          res.on('data', () => {})
          res.on('error', resolve)
          res.on('aborted', resolve)
          res.on('close', resolve)
        })
        req.on('error', resolve)
      })
      const [record] = await waitFor(1)
      expect(record).toMatchObject({ status: 200, termination: 'interrupted', route: '/partial' })
      expect(record.headerDurationMs).not.toBeNull()
      expect(await settle()).toHaveLength(1)
    } finally {
      await close()
    }
  })
})

describe('access log: interrupted connections (real sockets)', () => {
  test('client disconnect before headers: interrupted, status null, headerDurationMs null; a late response adds no record', async () => {
    let lateResponseDone
    const lateResponse = new Promise((resolve) => { lateResponseDone = resolve })
    const { app, waitFor, settle } = setup((a) => {
      a.get('/slow', (req, res) => {
        setTimeout(() => {
          res.send('too late')
          lateResponseDone()
        }, 200)
      })
    })
    const { port, close } = await listen(app)
    try {
      await abortAfter(port, '/slow', 50)
      const [record] = await waitFor(1)
      expect(record).toMatchObject({
        route: '/slow',
        status: null,
        headerDurationMs: null,
        termination: 'interrupted'
      })
      expect(record.durationMs).toBeLessThan(200)

      await lateResponse
      expect(await settle(100)).toHaveLength(1)
    } finally {
      await close()
    }
  })

  test('client disconnect mid-body: interrupted with the status that was actually sent', async () => {
    const { app, waitFor, settle } = setup((a) => {
      a.get('/stream', (req, res) => {
        res.status(206)
        res.write('first chunk')
        setTimeout(() => res.end('last chunk'), 300)
      })
    })
    const { port, close } = await listen(app)
    try {
      const headers = await abortAfterFirstChunk(port, '/stream')
      const [record] = await waitFor(1)
      expect(record).toMatchObject({
        requestId: headers['x-request-id'],
        status: 206,
        termination: 'interrupted'
      })
      expect(typeof record.headerDurationMs).toBe('number')
      expect(record.durationMs).toBeLessThan(300)
      await sleep(350)
      expect(await settle()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  test('a client that disconnected before observe() even ran is still logged once, as interrupted', async () => {
    const collector = collectingSink()
    const app = express()
    // A slow earlier middleware (think body parsing or auth) lets the client go away before observe() runs.
    app.use((req, res, next) => setTimeout(next, 150))
    app.use(observe({ log: { sink: collector.sink } }))
    app.get('/late', (req, res) => res.send('too late'))
    const { port, close } = await listen(app)
    try {
      await abortAfter(port, '/late', 30)
      const [record] = await collector.waitFor(1, 3000)
      // Route and status depend on whether the handler ran before the record was built; the contract here is
      // that the request is not lost and is not reported as finished.
      expect(record.termination).toBe('interrupted')
      await sleep(200)
      expect(await collector.settle()).toHaveLength(1)
    } finally {
      await close()
    }
  })

  test('a handler that never responds (e.g. an unhandled async rejection in Express 4) is logged once the client gives up', async () => {
    const { app, waitFor } = setup((a) => {
      a.get('/hang', () => { /* never responds */ })
    })
    const { port, close } = await listen(app)
    try {
      await abortAfter(port, '/hang', 30)
      const [record] = await waitFor(1)
      expect(record).toMatchObject({ route: '/hang', status: null, termination: 'interrupted' })
    } finally {
      await close()
    }
  })
})

describe('access log: header time vs total time (diagnostic-lab L1 / L2)', () => {
  test('late headers and slow body have similar totals but different headerDurationMs', async () => {
    const { app, waitFor } = setup((a) => {
      a.get('/late-headers', (req, res) => setTimeout(() => res.send('done'), 120))
      a.get('/slow-body', (req, res) => {
        res.write('start')
        setTimeout(() => res.end('done'), 120)
      })
    })
    await request(app).get('/late-headers')
    await request(app).get('/slow-body')
    const records = await waitFor(2)
    const late = records.find((r) => r.route === '/late-headers')
    const slow = records.find((r) => r.route === '/slow-body')

    expect(late.durationMs).toBeGreaterThanOrEqual(100)
    expect(slow.durationMs).toBeGreaterThanOrEqual(100)
    expect(late.headerDurationMs).toBeGreaterThanOrEqual(100)
    expect(slow.headerDurationMs).toBeLessThan(50)
  })
})
