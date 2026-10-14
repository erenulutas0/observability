'use strict'

// diagnostic-lab: one Express app that reproduces "this request was slow / failed" through different,
// deliberately bounded mechanisms, so the access-log records can be compared side by side.
//
// Safety rules (ARCHITECTURE.md section 10):
// - every delay, chunk count and failure mode comes from the allowlists below; no request parameter can choose
//   an arbitrary duration, size or CPU cost
// - binds to 127.0.0.1 only
// - synthetic data only, no external services

const express = require('express')
const observe = require('express-observe')

const HOST = '127.0.0.1'

/** L1: bounded wait before any header is written. */
const WAIT_BEFORE_HEADERS_MS = { short: 50, long: 150 }

/** L2: headers immediately, then the body in chunks. */
const SLOW_BODY = {
  short: { chunks: 3, intervalMs: 50 },
  long: { chunks: 6, intervalMs: 50 }
}

/** L7: how long the server takes before it would respond; the lab client disconnects earlier. */
const L7_RESPONSE_AFTER_MS = 500

/** L8: routes whose records the lab sink mishandles on purpose. */
const SINK_FAILURE_ROUTES = {
  '/lab/l8/throwing-sink': 'throw',
  '/lab/l8/rejecting-sink': 'reject',
  '/lab/l8/slow-sink': 'slow'
}
const SLOW_SINK_MS = 300

function writeJsonLine (record) {
  process.stdout.write(JSON.stringify(record) + '\n')
}

/**
 * A sink that behaves like a normal JSON-lines sink except for the L8 routes, where it throws, rejects,
 * or takes SLOW_SINK_MS before writing. It decides from record.route only.
 */
function createLabSink (write) {
  return function labSink (record) {
    switch (SINK_FAILURE_ROUTES[record.route]) {
      case 'throw':
        throw new Error('diagnostic-lab: sink unavailable (synchronous)')
      case 'reject':
        return Promise.reject(new Error('diagnostic-lab: sink unavailable (asynchronous)'))
      case 'slow':
        return new Promise((resolve) => setTimeout(() => {
          write(record)
          resolve()
        }, SLOW_SINK_MS))
      default:
        write(record)
    }
  }
}

/**
 * @param {{ write?: (record: object) => void, onSinkError?: (err: unknown, record: object) => void }} [options]
 */
function createApp (options = {}) {
  const write = options.write ?? writeJsonLine
  const app = express()
  app.disable('x-powered-by')

  app.use(observe({
    service: 'diagnostic-lab',
    release: '0.1.0-dev.0',
    route: { mounts: ['/tenants/:tenantId'] },
    log: { sink: createLabSink(write), onSinkError: options.onSinkError ?? null }
  }))

  // L0: normal small JSON.
  app.get('/lab/l0', (req, res) => {
    res.json({ scenario: 'L0', ok: true })
  })

  // L1: bounded asynchronous wait before headers. The custom timer is called "wait", not "db":
  // there is no database here, and a metric name should not suggest one.
  app.get('/lab/l1/:profile', (req, res) => {
    const delay = WAIT_BEFORE_HEADERS_MS[req.params.profile]
    if (delay === undefined) return res.status(404).json({ error: 'unknown profile' })
    res.serverTiming.start('wait')
    setTimeout(() => {
      res.serverTiming.end('wait')
      res.json({ scenario: 'L1', profile: req.params.profile })
    }, delay)
  })

  // L2: headers immediately, body produced slowly.
  app.get('/lab/l2/:profile', (req, res) => {
    const shape = SLOW_BODY[req.params.profile]
    if (shape === undefined) return res.status(404).json({ error: 'unknown profile' })
    res.type('text/plain')
    let sent = 0
    const tick = () => {
      sent++
      if (sent >= shape.chunks) return res.end(`chunk ${sent}\n`)
      res.write(`chunk ${sent}\n`)
      setTimeout(tick, shape.intervalMs)
    }
    tick()
  })

  // L7a: the server would answer after L7_RESPONSE_AFTER_MS; the lab client disconnects before any header.
  app.get('/lab/l7/before-headers', (req, res) => {
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) res.json({ scenario: 'L7', late: true })
    }, L7_RESPONSE_AFTER_MS)
  })

  // L7b: headers and a first chunk go out at once; the lab client disconnects after reading it.
  app.get('/lab/l7/mid-body', (req, res) => {
    res.type('text/plain')
    res.write('first chunk\n')
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) res.end('last chunk\n')
    }, L7_RESPONSE_AFTER_MS)
  })

  // L8: normal responses whose records hit a misbehaving sink.
  for (const route of Object.keys(SINK_FAILURE_ROUTES)) {
    app.get(route, (req, res) => res.json({ scenario: 'L8', route }))
  }

  // An application error passed to next(err).
  app.get('/lab/error', (req, res, next) => {
    next(new Error('diagnostic-lab: synthetic failure'))
  })

  // A nested router at a parameterized mount. The mount template is listed in route.mounts above,
  // so records say '/tenants/:tenantId/items/:itemId' and never the concrete tenant or item.
  const items = express.Router()
  items.get('/items/:itemId', (req, res) => res.json({ scenario: 'nested', ok: true }))
  app.use('/tenants/:tenantId', items)

  // The application's own error handler: returns the request ID so a user report can be matched to a log
  // record, and never sends or prints the error message or stack.
  app.use((err, req, res, _next) => {
    if (res.headersSent) return req.socket.destroy()
    res.status(500).json({ error: 'internal error', requestId: req.id })
  })

  return app
}

function start (port = Number(process.env.PORT) || 3000) {
  const app = createApp()
  const server = app.listen(port, HOST, () => {
    process.stderr.write(`diagnostic-lab listening on http://${HOST}:${server.address().port} (records go to stdout)\n`)
  })
  return server
}

if (require.main === module) start()

module.exports = {
  createApp,
  start,
  HOST,
  WAIT_BEFORE_HEADERS_MS,
  SLOW_BODY,
  L7_RESPONSE_AFTER_MS,
  SLOW_SINK_MS
}
