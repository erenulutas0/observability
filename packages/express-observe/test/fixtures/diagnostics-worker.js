'use strict'

// Loads the package inside a worker thread, serves two requests with plain node:http, and posts the worker's own
// diagnostics snapshot back to the main thread.
const http = require('node:http')
const { parentPort, workerData } = require('node:worker_threads')
const observe = require(workerData.packagePath)

const middleware = observe({ log: { sink: () => {} } })
const server = http.createServer((req, res) => middleware(req, res, () => res.end('ok')))

function get (port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume()
      res.on('end', resolve)
    }).on('error', reject)
  })
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address()
  await get(port)
  await get(port)
  // Records are emitted on the server's 'finish', which can come after the client has read the response.
  while (observe.getDiagnostics().records.emitted < 2) await new Promise((resolve) => setTimeout(resolve, 5))
  server.close()
  parentPort.postMessage(observe.getDiagnostics())
})
