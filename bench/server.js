'use strict'

// Benchmark target. Started as a child process by run.js, one fresh process per measured run.
//
//   node server.js <variant>
//
// Talks to the parent over IPC:
//   child  -> { type: 'ready', port }
//   parent -> { type: 'mark' }   child -> { type: 'marked' }      start of the measured window
//   parent -> { type: 'stats' }  child -> { type: 'stats', ... }  counters and resource use since 'mark'
//
// Access logs go to this process's stdout, which run.js redirects to a file.

const { randomUUID } = require('node:crypto')
const express = require('express')
// EXPRESS_OBSERVE_MODULE lets bench/ab.js load another copy of the package (e.g. the main branch) for A/B runs.
const observe = require(process.env.EXPRESS_OBSERVE_MODULE || 'express-observe')
const pinoHttp = require('pino-http')

const VARIANTS = {
  // Express with no observability middleware.
  baseline: () => {},

  // Request IDs and Server-Timing only; no access log.
  'ids-timing': (app) => app.use(observe({ service: 'bench', release: '0.1.0-dev.0', log: { enabled: false } })),

  // Everything on, default sink: one JSON line per request on stdout.
  'full-log': (app) => app.use(observe({ service: 'bench', release: '0.1.0-dev.0' })),

  // An established HTTP logger configured to roughly match: a UUID request ID echoed in X-Request-Id,
  // one line per request on stdout, method and status only (pino-http logs URL, headers and remote address
  // by default; those are stripped here to keep the comparison closer). No Server-Timing, no route template.
  'pino-http': (app) => app.use(pinoHttp({
    base: null,
    genReqId: (req, res) => {
      const id = randomUUID()
      res.setHeader('X-Request-Id', id)
      return id
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method }),
      res: (res) => ({ statusCode: res.statusCode })
    }
  }))
}

const variant = process.argv[2]
if (!Object.hasOwn(VARIANTS, variant)) {
  process.stderr.write(`unknown variant ${JSON.stringify(variant)}; expected one of ${Object.keys(VARIANTS).join(', ')}\n`)
  process.exit(2)
}

let requestsTotal = 0
let requestsAtMark = 0
let cpuAtMark = null

const app = express()
app.disable('x-powered-by')
app.disable('etag')
VARIANTS[variant](app)
app.get('/users/:id', (req, res) => {
  requestsTotal++
  res.json({ id: req.params.id, ok: true })
})

const server = app.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', port: server.address().port })
})

process.on('message', (msg) => {
  if (msg.type === 'mark') {
    requestsAtMark = requestsTotal
    cpuAtMark = process.cpuUsage()
    process.send({ type: 'marked' })
  } else if (msg.type === 'stats') {
    const cpu = process.cpuUsage(cpuAtMark ?? undefined)
    const usage = process.resourceUsage()
    process.send({
      type: 'stats',
      requestsTotal,
      requestsMeasured: requestsTotal - requestsAtMark,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      rssBytes: process.memoryUsage().rss,
      maxRssKb: usage.maxRSS
    })
  }
})

process.on('disconnect', () => process.exit(0))
