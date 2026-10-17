'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const express = require('express')
const observe = require('../src')
const { isLoopbackHost, parseServerTiming, MAX_PATHS } = require('../src/doctor')
const { listen } = require('./helpers/http')

const BIN = path.join(__dirname, '..', 'bin', 'express-observe.js')
const VERSION = require('../package.json').version

let tmp
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'express-observe-doctor-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function doctorCli (args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'doctor', ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ status: err ? err.code : 0, stdout, stderr })
    })
  })
}

let logCounter = 0
/** A JSON-lines file sink that writes synchronously, so doctor can read it immediately. */
function fileSink () {
  const file = path.join(tmp, `access-${++logCounter}.jsonl`)
  fs.writeFileSync(file, '')
  return { file, sink: (record) => fs.appendFileSync(file, JSON.stringify(record) + '\n') }
}

/**
 * Start an app on loopback, run doctor against it, stop the app.
 * `build(app, log)` registers middleware and routes; it receives the file sink.
 */
async function diagnose (build, { paths = ['/'], withLog = true, extraArgs = [] } = {}) {
  const log = fileSink()
  const app = express()
  build(app, log)
  const { port, close } = await listen(app)
  try {
    const args = [`http://127.0.0.1:${port}`, '--json', '--wait', '50', ...extraArgs]
    for (const p of paths) args.push('--path', p)
    if (withLog) args.push('--log', log.file)
    const result = await doctorCli(args)
    const report = result.stdout ? JSON.parse(result.stdout) : null
    return { ...result, report, logFile: log.file }
  } finally {
    await close()
  }
}

const checkOf = (report, id) => report.checks.find((c) => c.id === id)

function itemsRouter () {
  const router = express.Router()
  router.get('/items/:itemId', (req, res) => res.json({ ok: true }))
  return router
}

function healthy (app, log, options = {}) {
  app.use(observe({ service: 'doctor-test', route: { mounts: ['/api'] }, log: { sink: log.sink }, ...options }))
  app.get('/', (req, res) => res.send('home'))
  app.use('/api', itemsRouter())
}

describe('doctor: a correct integration', () => {
  test('passes every check, with 2 probes per path plus 2', async () => {
    const { status, report } = await diagnose(healthy, { paths: ['/', '/api/items/7'] })
    expect(status).toBe(0)
    expect(report.failures).toBe(0)
    expect(report.warnings).toBe(0)
    expect(report.requests).toBe(6)
    for (const c of report.checks) expect(['pass', 'info']).toContain(c.status)
    expect(checkOf(report, 'client-id-policy').summary).toMatch(/^not accepted/)
  })

  test('without --log the log checks are skipped and the run still passes', async () => {
    const { status, report } = await diagnose(healthy, { withLog: false })
    expect(status).toBe(0)
    for (const id of ['log-record-count', 'route-label', 'privacy-markers']) {
      expect(checkOf(report, id)).toMatchObject({ status: 'skip', summary: 'needs --log <file>' })
    }
  })

  test('the text report lists every check and the result line', async () => {
    const log = fileSink()
    const app = express()
    healthy(app, log)
    const { port, close } = await listen(app)
    try {
      const { status, stdout } = await doctorCli([`http://127.0.0.1:${port}`, '--log', log.file, '--wait', '50'])
      expect(status).toBe(0)
      expect(stdout).toMatch(/^express-observe doctor: http:\/\/127\.0\.0\.1:\d+ \(4 GET requests, log: /)
      expect(stdout).toMatch(/PASS {2}log-record-count/)
      expect(stdout).toMatch(/Result: 0 failure\(s\), 0 warning\(s\)\./)
    } finally {
      await close()
    }
  })
})

describe('doctor: detects integration mistakes', () => {
  test('no middleware at all', async () => {
    const { status, report } = await diagnose((app) => app.get('/', (req, res) => res.send('home')))
    expect(status).toBe(1)
    expect(checkOf(report, 'request-id-header').status).toBe('fail')
    expect(checkOf(report, 'not-found-path').status).toBe('fail')
    expect(checkOf(report, 'server-timing').status).toBe('warn')
  })

  test('observe() registered after a middleware that answers', async () => {
    const { status, report } = await diagnose((app, log) => {
      app.use('/health', (req, res) => res.send('ok'))
      healthy(app, log)
    }, { paths: ['/', '/health'] })
    expect(status).toBe(1)
    const c = checkOf(report, 'request-id-header')
    expect(c.status).toBe('fail')
    expect(c.details.join('\n')).toMatch(/GET \/health: no X-Request-Id/)
    expect(c.details.join('\n')).not.toMatch(/GET \/: /)
  })

  test('the same record written twice', async () => {
    const { status, report } = await diagnose((app, log) => {
      app.use(observe({ log: { sink: (r) => { log.sink(r); log.sink(r) } } }))
      app.get('/', (req, res) => res.send('home'))
    })
    expect(status).toBe(1)
    const c = checkOf(report, 'log-record-count')
    expect(c.status).toBe('fail')
    expect(c.details[0]).toMatch(/2 records/)
  })

  test('a router mount missing from route.mounts gives a warning, not a failure', async () => {
    const { status, report } = await diagnose((app, log) => {
      app.use(observe({ log: { sink: log.sink } }))
      app.use('/api', itemsRouter())
    }, { paths: ['/api/items/7'] })
    expect(status).toBe(0)
    const c = checkOf(report, 'route-label')
    expect(c.status).toBe('warn')
    expect(c.details[0]).toMatch(/route is null.*route\.mounts/)
  })

  test('text output prints a repeated detail once with a count; JSON keeps every occurrence', async () => {
    const log = fileSink()
    const app = express()
    app.use(observe({ log: { sink: log.sink } }))
    app.use('/api', itemsRouter())
    const { port, close } = await listen(app)
    try {
      const target = `http://127.0.0.1:${port}`
      const text = await doctorCli([target, '--wait', '50', '--path', '/api/items/7', '--log', log.file])
      const lines = text.stdout.split('\n').filter((l) => l.includes('GET /api/items/7: answered 200 but the route is null'))
      expect(text.stdout).toMatch(/request-id-unique\s+\d+ distinct ID\(s\); the client-ID probe is excluded/)

      // Every probe of the path produces the same detail; the first path also gets the client-ID probe.
      const json = JSON.parse((await doctorCli([target, '--json', '--wait', '50', '--path', '/api/items/7', '--log', log.file])).stdout)
      const occurrences = checkOf(json, 'route-label').details.filter((d) => d.includes('/api/items/7')).length
      expect(occurrences).toBeGreaterThan(1)
      expect(lines).toHaveLength(1)
      expect(lines[0].endsWith(` (${occurrences} times)`)).toBe(true)
    } finally {
      await close()
    }
  })

  test('log.extend that copies the URL leaks the query marker', async () => {
    const { status, report } = await diagnose((app, log) => {
      app.use(observe({ log: { sink: log.sink, extend: (req) => ({ url: req.originalUrl }) } }))
      app.get('/', (req, res) => res.send('home'))
    })
    expect(status).toBe(1)
    expect(checkOf(report, 'privacy-markers').status).toBe('fail')
  })

  test('log.extend that copies headers leaks the header marker', async () => {
    const { report } = await diagnose((app, log) => {
      app.use(observe({ log: { sink: log.sink, extend: (req) => ({ headers: req.headers }) } }))
      app.get('/', (req, res) => res.send('home'))
    })
    expect(checkOf(report, 'privacy-markers').status).toBe('fail')
  })

  test('a middleware that overwrites X-Request-Id with a constant', async () => {
    const { status, report } = await diagnose((app, log) => {
      healthy(app, log)
      app.use((req, res, next) => { res.setHeader('X-Request-Id', 'fixed-id'); next() })
    }, { paths: ['/nothing-here'] })
    expect(status).toBe(1)
    expect(checkOf(report, 'request-id-unique').status).toBe('fail')
  })

  test('an explicit label that returns the raw path is caught on the unmatched probe', async () => {
    const { status, report } = await diagnose((app, log) => {
      app.use(observe({ log: { sink: log.sink } }))
      app.get('/', (req, res) => res.send('home'))
      app.use((req, res) => {
        res.locals.observeRoute = req.path
        res.status(404).send('not found')
      })
    })
    expect(status).toBe(1)
    const c = checkOf(report, 'route-label')
    expect(c.status).toBe('fail')
    expect(c.details[0]).toMatch(/raw URL/)
  })

  test('a malformed Server-Timing value set by the app', async () => {
    const { status, report } = await diagnose((app, log) => {
      app.use(observe({ log: { sink: log.sink } }))
      app.get('/', (req, res) => {
        res.setHeader('Server-Timing', 'bad name;dur=1')
        res.send('home')
      })
    })
    expect(status).toBe(1)
    expect(checkOf(report, 'server-timing').status).toBe('fail')
  })

  test('serverTiming disabled is a warning', async () => {
    const { status, report } = await diagnose((app, log) => healthy(app, log, { serverTiming: { enabled: false } }))
    expect(status).toBe(0)
    expect(checkOf(report, 'server-timing').status).toBe('warn')
  })

  test('trustIncoming is reported as accepted client IDs', async () => {
    const { report } = await diagnose((app, log) => healthy(app, log, { requestId: { trustIncoming: true } }))
    expect(checkOf(report, 'client-id-policy')).toMatchObject({ status: 'info', summary: expect.stringMatching(/^accepted/) })
  })

  test('an unreadable log file fails the log checks', async () => {
    const { status, report } = await diagnose(healthy, { withLog: false, extraArgs: ['--log', path.join(tmp, 'missing.jsonl')] })
    expect(status).toBe(1)
    expect(checkOf(report, 'log-record-count')).toMatchObject({ status: 'fail', summary: expect.stringMatching(/no such file/) })
  })

  test('an unreachable server fails reachable and skips the rest', async () => {
    const { port, close } = await listen(express())
    await close()
    const { status, stdout } = await doctorCli([`http://127.0.0.1:${port}`, '--json'])
    const report = JSON.parse(stdout)
    expect(status).toBe(1)
    expect(checkOf(report, 'reachable').status).toBe('fail')
    expect(report.requests).toBe(1)
    for (const c of report.checks.filter((x) => x.id !== 'reachable')) expect(c.status).toBe('skip')
  })
})

describe('doctor: safety boundaries', () => {
  test('sends only identified GET requests without credentials, within the request budget, and does not follow redirects', async () => {
    const seen = []
    const { report } = await diagnose((app, log) => {
      app.use((req, res, next) => {
        seen.push({ method: req.method, path: req.path, ua: req.headers['user-agent'], cookie: req.headers.cookie, auth: req.headers.authorization })
        next()
      })
      healthy(app, log)
      app.get('/old', (req, res) => res.redirect('/new'))
      app.get('/new', (req, res) => res.send('moved here'))
    }, { paths: ['/', '/old'] })

    expect(report.requests).toBe(6)
    expect(seen).toHaveLength(6)
    for (const r of seen) {
      expect(r.method).toBe('GET')
      expect(r.ua).toBe(`express-observe-doctor/${VERSION}`)
      expect(r.cookie).toBeUndefined()
      expect(r.auth).toBeUndefined()
    }
    expect(seen.some((r) => r.path === '/new')).toBe(false)
  })

  test('stops reading an endless response body instead of hanging', async () => {
    const started = Date.now()
    const { report } = await diagnose((app, log) => {
      healthy(app, log)
      app.get('/stream', (req, res) => {
        const chunk = Buffer.alloc(16 * 1024, 120)
        const timer = setInterval(() => res.write(chunk), 1)
        res.on('close', () => clearInterval(timer))
      })
    }, { paths: ['/stream'], withLog: false })
    expect(checkOf(report, 'reachable').status).toBe('pass')
    expect(Date.now() - started).toBeLessThan(4000)
  }, 20000)

  test('a server that trickles bytes cannot hold a probe past --timeout', async () => {
    const started = Date.now()
    const { report } = await diagnose((app, log) => {
      healthy(app, log)
      app.get('/drip', (req, res) => {
        res.write('x')
        const timer = setInterval(() => res.write('x'), 100)
        res.on('close', () => clearInterval(timer))
      })
    }, { paths: ['/', '/drip'], withLog: false, extraArgs: ['--timeout', '1000'] })
    const elapsed = Date.now() - started
    expect(checkOf(report, 'reachable').status).toBe('pass')
    expect(report.probes.filter((p) => p.path === '/drip').map((p) => p.bodyTruncated)).toEqual([true, true])
    expect(elapsed).toBeGreaterThanOrEqual(1900)
    expect(elapsed).toBeLessThan(6000)
  }, 20000)

  test('refuses a non-loopback target before connecting', async () => {
    const started = Date.now()
    const { status, stderr, stdout } = await doctorCli(['http://192.0.2.10:3000'])
    expect(status).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/refusing to probe 192\.0\.2\.10/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test.each([
    [['http://127.0.0.1:3000', '--path', 'api']],
    [['http://127.0.0.1:3000', '--path', '//evil.example/x']],
    [['http://127.0.0.1:3000', '--path', '/a b']],
    [['http://127.0.0.1:3000', ...Array.from({ length: MAX_PATHS + 1 }, (_, i) => ['--path', `/p${i}`]).flat()]],
    [['http://127.0.0.1:3000/api']],
    [['http://user:pass@127.0.0.1:3000']],
    [['ftp://127.0.0.1']],
    [['not a url']],
    [['http://127.0.0.1:3000', '--wait', '20000']],
    [['http://127.0.0.1:3000', '--timeout', '100']],
    [['http://127.0.0.1:3000', '--timeout', 'soon']],
    [['http://127.0.0.1:3000', '--header', 'bad header']],
    [[]]
  ])('usage error %j exits 2 without probing', async (args) => {
    const { status, stdout } = await doctorCli(args)
    expect(status).toBe(2)
    expect(stdout).toBe('')
  })

  test('loopback detection', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['10.0.0.1', '192.168.1.5', 'example.com', '127.0.0.1.nip.io', 'localhost.example.com', '0.0.0.0']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('doctor: Server-Timing validation', () => {
  test.each([
    ['app;dur=1.5', true],
    ['db;dur=2, cache;desc="hit \\"warm\\"", app;dur=0.1', true],
    ['miss', true],
    ['bad name;dur=1', false],
    ['db;dur=fast', false],
    ['db;desc=two words', false]
  ])('%s is valid: %s', (value, ok) => {
    expect(parseServerTiming(value).ok).toBe(ok)
  })
})
