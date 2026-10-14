'use strict'

// Example API for the React Native correlation demo.
//
//   node server.js                      listens on 127.0.0.1:4000 (Android emulator: http://10.0.2.2:4000,
//                                        iOS simulator: http://127.0.0.1:4000)
//   HOST=0.0.0.0 node server.js         also reachable from a phone on your LAN; only do this on a trusted network
//
// Access-log records go to stdout as JSON lines: node server.js > access.jsonl
// Synthetic data only. Every delay and size comes from the constants below, not from the request.

const express = require('express')
const observe = require('express-observe')

const DEFAULT_PORT = 4000
const SLOW_MS = 300
const STALL_MS = 2000
const SMALL_ITEMS = buildItems(20)
const LARGE_ITEMS = buildItems(2000)

function buildItems (n) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Synthetic item ${i + 1}`, tags: ['demo', 'synthetic'] }))
}

/**
 * @param {{ sink?: (record: object) => void, trustIncoming?: boolean }} [options]
 */
function createApp (options = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.disable('etag')

  app.use(observe({
    service: 'rn-correlation-demo',
    release: '0.1.0-dev.0',
    // The demo client sends its own X-Request-Id per attempt, so a request it gave up on can still be found in
    // the server log. Accepted IDs are correlation data, not identity: records mark them with
    // requestIdSource "client", and any client could choose them. Decide this per deployment.
    requestId: { trustIncoming: options.trustIncoming ?? true },
    route: { mounts: ['/api'] },
    log: options.sink ? { sink: options.sink } : {}
  }))

  const api = express.Router()

  // Small or large JSON from a fixed allowlist; the large one shows client-side parsing in clientAttemptMs.
  api.get('/items', (req, res) => {
    const items = req.query.size === 'large' ? LARGE_ITEMS : SMALL_ITEMS
    res.json({ items })
  })

  // Server-side wait before any header, timed as "wait" in Server-Timing.
  api.get('/items/slow', (req, res) => {
    res.serverTiming.start('wait')
    setTimeout(() => {
      res.serverTiming.end('wait')
      res.json({ items: SMALL_ITEMS })
    }, SLOW_MS)
  })

  // Every other request fails with 503, so a client retry produces two attempts in one operation.
  let flakyCounter = 0
  api.get('/flaky', (req, res) => {
    flakyCounter++
    if (flakyCounter % 2 === 1) return res.status(503).json({ error: 'temporarily unavailable' })
    res.json({ items: SMALL_ITEMS })
  })

  // Answers after STALL_MS; a client with a shorter timeout gives up first.
  api.get('/stall', (req, res) => {
    setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) res.json({ items: SMALL_ITEMS })
    }, STALL_MS)
  })

  app.use('/api', api)
  app.use((err, req, res, _next) => {
    if (res.headersSent) return req.socket.destroy()
    res.status(500).json({ error: 'internal error', requestId: req.id })
  })
  return app
}

function start () {
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT) || DEFAULT_PORT
  const server = createApp().listen(port, host, () => {
    process.stderr.write(`rn-correlation-demo API on http://${host}:${server.address().port} (access log on stdout)\n`)
    if (host !== '127.0.0.1' && host !== 'localhost') {
      process.stderr.write('Warning: listening beyond loopback. Anyone on this network can reach this demo API.\n')
    }
  })
  return server
}

if (require.main === module) start()

module.exports = { createApp, SLOW_MS, STALL_MS }
