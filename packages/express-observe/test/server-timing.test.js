'use strict'

const express = require('express')
const request = require('supertest')
const observe = require('../src')

// These tests are about headers, not logging: keep the default stdout sink from flooding the test output.
beforeAll(() => { jest.spyOn(process.stdout, 'write').mockImplementation(() => true) })
afterAll(() => { jest.restoreAllMocks() })
const { parseServerTiming } = require('./helpers/server-timing-parser')
const { sleep } = require('./helpers/http')

function appWith (handler, options) {
  const app = express()
  app.use(observe(options))
  app.get('/', handler)
  return app
}

async function timingsFor (app, path = '/') {
  const res = await request(app).get(path)
  return { res, metrics: parseServerTiming(res.headers['server-timing']) }
}

const names = (metrics) => metrics.map((m) => m.name)
const metric = (metrics, name) => metrics.find((m) => m.name === name)

describe('Server-Timing: built-in app metric', () => {
  test('every response carries exactly one app;dur entry with a non-negative duration', async () => {
    const { res, metrics } = await timingsFor(appWith((req, res) => res.send('ok')))
    expect(res.status).toBe(200)
    expect(names(metrics)).toEqual(['app'])
    expect(metrics[0].dur).toBeGreaterThanOrEqual(0)
    expect(res.headers['server-timing']).toMatch(/^app;dur=\d+\.\d$/)
  })

  test('app measures time to headers, not the whole response (streaming body)', async () => {
    const app = appWith((req, res) => {
      res.write('first chunk')
      setTimeout(() => res.end('last chunk'), 150)
    })
    const started = Date.now()
    const { res, metrics } = await timingsFor(app)
    const total = Date.now() - started

    expect(res.text).toBe('first chunklast chunk')
    expect(total).toBeGreaterThanOrEqual(140)
    expect(metric(metrics, 'app').dur).toBeLessThan(75)
  })

  test('res.flushHeaders() finalizes the header early', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.start('before')
      res.serverTiming.end('before')
      res.flushHeaders()
      res.serverTiming.add('after', 5)
      setTimeout(() => res.end('done'), 50)
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['before', 'app'])
  })

  test('explicit res.writeHead() is intercepted', async () => {
    const app = appWith((req, res) => {
      res.writeHead(204)
      res.end()
    })
    const { res, metrics } = await timingsFor(app)
    expect(res.status).toBe(204)
    expect(names(metrics)).toEqual(['app'])
  })

  test('is present on unmatched 404 and on errors passed to next(err)', async () => {
    const app = express()
    app.use(observe())
    app.get('/boom', (req, res, next) => {
      res.serverTiming.add('db', 3)
      next(new Error('synthetic failure'))
    })

    const notFound = await timingsFor(app, '/missing')
    expect(notFound.res.status).toBe(404)
    expect(names(notFound.metrics)).toEqual(['app'])

    const failed = await timingsFor(app, '/boom')
    expect(failed.res.status).toBe(500)
    expect(names(failed.metrics)).toEqual(['db', 'app'])
  })

  test("is present when the application's own error middleware responds", async () => {
    const app = express()
    app.use(observe())
    app.get('/', () => { throw new Error('synthetic failure') })
    app.use((err, req, res, _next) => res.status(503).json({ error: 'unavailable' }))

    const { res, metrics } = await timingsFor(app)
    expect(res.status).toBe(503)
    expect(names(metrics)).toEqual(['app'])
  })

  test('mounting observe() twice produces a single app entry', async () => {
    const app = express()
    app.use(observe())
    app.use(observe())
    app.get('/', (req, res) => res.send('ok'))
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['app'])
  })
})

describe('Server-Timing: custom timers', () => {
  test('start/end measures elapsed time on a monotonic clock and is listed before app', async () => {
    const app = appWith(async (req, res) => {
      res.serverTiming.start('db')
      await sleep(30)
      res.serverTiming.end('db')
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['db', 'app'])
    expect(metric(metrics, 'db').dur).toBeGreaterThanOrEqual(25)
    expect(metric(metrics, 'app').dur).toBeGreaterThanOrEqual(metric(metrics, 'db').dur)
  })

  test('add() records a precomputed duration and a sanitized, quoted description', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.add('cache', 0.42, 'hit')
      res.serverTiming.add('weird', 1, 'hit "warm" \\ é\r\n' + 'x'.repeat(100))
      res.send('ok')
    })
    const { res, metrics } = await timingsFor(app)
    expect(res.status).toBe(200)
    expect(metric(metrics, 'cache')).toMatchObject({ dur: 0.4, desc: 'hit' })
    // non-printable / non-ASCII removed, truncated to 64 characters, quotes and backslash escaped on the wire
    expect(metric(metrics, 'weird').desc).toBe('hit "warm" \\ ' + 'x'.repeat(51))
    expect(res.headers['server-timing']).not.toMatch(/[\r\n]/)
  })

  test('a duplicate start() restarts the timer (latest start wins)', async () => {
    const app = appWith(async (req, res) => {
      res.serverTiming.start('db')
      await sleep(80)
      res.serverTiming.start('db')
      await sleep(5)
      res.serverTiming.end('db')
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(metric(metrics, 'db').dur).toBeLessThan(40)
  })

  test('a second start/end pair for the same name replaces the earlier duration', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.add('db', 50)
      res.serverTiming.start('db')
      res.serverTiming.end('db')
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['db', 'app'])
    expect(metric(metrics, 'db').dur).toBeLessThan(50)
  })

  test('end() without start() is ignored', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.end('never-started')
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['app'])
  })

  test('an unfinished timer is omitted from the header', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.start('pending')
      res.serverTiming.start('done')
      res.serverTiming.end('done')
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['done', 'app'])
  })

  test('calls after headers are sent are silent no-ops and the response completes', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.start('spans-flush')
      res.write('chunk')
      res.serverTiming.end('spans-flush')
      res.serverTiming.start('late')
      res.serverTiming.end('late')
      res.serverTiming.add('late-add', 1)
      res.end('end')
    })
    const { res, metrics } = await timingsFor(app)
    expect(res.status).toBe(200)
    expect(res.text).toBe('chunkend')
    expect(names(metrics)).toEqual(['app'])
  })

  test.each([
    ['empty string', ''],
    ['whitespace', 'db query'],
    ['33 characters', 'n'.repeat(33)],
    ['reserved name app', 'app'],
    ['header delimiter', 'db;dur=1'],
    ['non-string', 42],
    ['null', null]
  ])('ignores an invalid timer name (%s)', async (_label, name) => {
    const app = appWith((req, res) => {
      res.serverTiming.start(name)
      res.serverTiming.end(name)
      res.serverTiming.add(name, 1)
      res.send('ok')
    })
    const { res, metrics } = await timingsFor(app)
    expect(res.status).toBe(200)
    expect(names(metrics)).toEqual(['app'])
  })

  test.each([
    ['NaN', NaN],
    ['negative', -1],
    ['Infinity', Infinity],
    ['string', '5']
  ])('add() ignores an invalid duration (%s)', async (_label, dur) => {
    const app = appWith((req, res) => {
      res.serverTiming.add('db', dur)
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['app'])
  })

  test('maxEntries caps distinct names; app is not counted', async () => {
    const app = appWith((req, res) => {
      for (const n of ['t1', 't2', 't3', 't4']) res.serverTiming.add(n, 1)
      res.send('ok')
    }, { serverTiming: { maxEntries: 2 } })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['t1', 't2', 'app'])
  })

  test('the default cap is 16 custom entries', async () => {
    const app = appWith((req, res) => {
      for (let i = 0; i < 100; i++) res.serverTiming.add(`m${i}`, 1)
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(metrics).toHaveLength(17)
    expect(metrics.at(-1).name).toBe('app')
  })
})

describe('Server-Timing: coexistence and opt-out', () => {
  test('appends to a Server-Timing header the application already set with setHeader', async () => {
    const app = appWith((req, res) => {
      res.setHeader('Server-Timing', 'cdn;dur=5')
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['cdn', 'app'])
  })

  test('appends to a Server-Timing header passed in the writeHead() headers object', async () => {
    const app = appWith((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Server-Timing': 'edge;dur=2' })
      res.end('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['edge', 'app'])
  })

  test('appends to a multi-value Server-Timing header', async () => {
    const app = appWith((req, res) => {
      res.setHeader('Server-Timing', ['a;dur=1', 'b;dur=2'])
      res.send('ok')
    })
    const { metrics } = await timingsFor(app)
    expect(names(metrics)).toEqual(['a', 'b', 'app'])
  })

  test('serverTiming.enabled: false sends no header but keeps res.serverTiming callable', async () => {
    const app = appWith((req, res) => {
      res.serverTiming.start('db')
      res.serverTiming.end('db')
      res.serverTiming.add('cache', 1)
      res.send('ok')
    }, { serverTiming: { enabled: false } })
    const { res } = await timingsFor(app)
    expect(res.status).toBe(200)
    expect(res.headers['server-timing']).toBeUndefined()
    expect(res.headers['x-request-id']).toBeDefined()
  })
})
