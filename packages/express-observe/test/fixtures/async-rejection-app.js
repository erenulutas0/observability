'use strict'

// Child-process fixture for test/async-rejection-process.test.js. It runs outside Jest so that Node's real
// unhandled-rejection behaviour is observed instead of the test runner's own handling.
//
//   EXPRESS_MODULE=<resolved path to express or express5> node async-rejection-app.js
//
// Prints "PORT <n>" when listening and "RECORD <json>" for every access-log record.

const path = require('node:path')
const express = require(process.env.EXPRESS_MODULE)
const observe = require(path.join(__dirname, '..', '..', 'src'))

const app = express()
app.use(observe({ log: { sink: (record) => process.stdout.write(`RECORD ${JSON.stringify(record)}\n`) } }))
app.get('/async-fail', async () => {
  throw new Error('fixture async failure')
})
app.get('/ok', (req, res) => res.send('ok'))

const server = app.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${server.address().port}\n`)
})
