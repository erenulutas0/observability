'use strict'

const net = require('node:net')

/** Start an app on an ephemeral loopback port. */
function listen (app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        port,
        close: () => new Promise((resolveClose) => {
          server.closeAllConnections()
          server.close(() => resolveClose())
        })
      })
    })
    server.on('error', reject)
  })
}

/**
 * Send raw bytes over a real TCP socket and collect the full response text.
 * Used where an HTTP client library would normalise or refuse the input (duplicate headers, raw bytes).
 * @param {number} port
 * @param {Buffer | string} payload
 */
function rawRequest (port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    socket.on('connect', () => socket.end(payload))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')))
    socket.on('error', reject)
  })
}

/** Extract a header value from a raw HTTP/1.1 response text. Returns all values for repeated headers. */
function rawHeaderValues (responseText, name) {
  const head = responseText.split('\r\n\r\n')[0]
  const prefix = name.toLowerCase() + ':'
  return head
    .split('\r\n')
    .slice(1)
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
}

function rawStatus (responseText) {
  return Number(responseText.split(' ')[1])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = { listen, rawRequest, rawHeaderValues, rawStatus, sleep }
