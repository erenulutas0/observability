'use strict'

// Runtime check of the installed package, as plain CommonJS.
const assert = require('node:assert')
const http = require('node:http')
const express = require('express')
const observe = require('express-observe')
const { observe: named } = require('express-observe')

assert.strictEqual(typeof observe, 'function')
assert.strictEqual(named, observe)

const records = []
const app = express()
app.use(observe({ service: 'consumer', log: { sink: (record) => { records.push(record) } } }))
app.get('/users/:id', (req, res) => {
  res.serverTiming.start('db')
  res.serverTiming.end('db')
  res.json({ id: req.id })
})

const server = app.listen(0, '127.0.0.1', () => {
  http.get({ host: '127.0.0.1', port: server.address().port, path: '/users/42?token=secret', agent: false }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => {
      setTimeout(() => {
        server.close()
        const id = res.headers['x-request-id']
        assert.match(id, /^[0-9a-f-]{36}$/)
        assert.strictEqual(JSON.parse(body).id, id)
        assert.match(res.headers['server-timing'], /^db;dur=\d+\.\d, app;dur=\d+\.\d$/)
        assert.strictEqual(records.length, 1)
        assert.deepStrictEqual(
          { requestId: records[0].requestId, route: records[0].route, status: records[0].status, termination: records[0].termination },
          { requestId: id, route: '/users/:id', status: 200, termination: 'finished' }
        )
        assert.ok(!JSON.stringify(records[0]).includes('secret'))
        process.stdout.write('runtime ok\n')
      }, 50)
    })
  })
})
