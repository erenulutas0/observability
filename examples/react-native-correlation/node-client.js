'use strict'

// Runs the demo end to end without a phone: starts the example API in-process, plays a short session with the same
// correlation.js the React Native app uses, and prints the joined client/server view.
//
//   node node-client.js [--out=<dir>]   also write client.jsonl and access.jsonl to <dir>
//
// This exercises the correlation logic over real HTTP on loopback. It is NOT evidence about mobile behaviour:
// no radio network, no Hermes, no device CPU, no UI rendering.

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createApp } = require('./server')
const { createTracedClient, formatAttemptLine } = require('./correlation')
const { joinAttempts, renderJoin } = require('./join')

const SESSION = [
  { label: 'list (small)', path: '/api/items' },
  { label: 'list (large)', path: '/api/items?size=large' },
  { label: 'slow list', path: '/api/items/slow' },
  { label: 'flaky, with retry', path: '/api/flaky', maxAttempts: 3 },
  { label: 'stall, client gives up', path: '/api/stall', timeoutMs: 800 }
]

async function runSession ({ trustIncoming = true } = {}) {
  const serverRecords = []
  const clientAttempts = []
  const app = createApp({ sink: (r) => serverRecords.push(r), trustIncoming })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const client = createTracedClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      newId: randomUUID,
      onAttempt: (a) => clientAttempts.push(a)
    })
    for (const step of SESSION) {
      await client.request(step.path, { operationName: step.label, maxAttempts: step.maxAttempts, timeoutMs: step.timeoutMs })
    }
    // Let interrupted requests be logged, then stop.
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return { clientAttempts, serverRecords }
}

async function main () {
  const outArg = process.argv.find((a) => a.startsWith('--out='))
  const { clientAttempts, serverRecords } = await runSession()
  if (outArg) {
    const dir = outArg.slice('--out='.length)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'client.jsonl'), clientAttempts.map(formatAttemptLine).join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'access.jsonl'), serverRecords.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  process.stdout.write('Node client against the example API on loopback (not mobile evidence).\n\n')
  process.stdout.write(renderJoin(joinAttempts(clientAttempts, serverRecords)))
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`node-client failed: ${err && err.stack}\n`)
    process.exitCode = 1
  })
}

module.exports = { runSession, SESSION }
