'use strict'

const express = require('express')
const request = require('supertest')
const observe = require('../src')
const { sleep } = require('./helpers/http')
const { RECORD_KEYS } = require('./helpers/records')

// Synthetic sentinel values. Each one is planted in a different part of the request or of the application's
// behaviour; none of them may appear anywhere in what the middleware writes.
const SENTINELS = {
  pathParam: 'pathsecret8231',
  mountParam: 'mountsecret4410',
  query: 'querysecret5512',
  email: 'jane.synthetic@example.test',
  bearer: 'bearertoken9f3a77c1',
  cookie: 'cookiesecret0c1d',
  password: 'passwordsecret!42',
  bodyField: 'bodysecret7781',
  forwardedIp: '203.0.113.77',
  userAgent: 'useragentsecret66',
  customHeader: 'headersecret1234',
  errorMessage: 'errorsecret3399',
  responseBody: 'responsesecret5050',
  userId: 'usersecret2718'
}

function buildApp () {
  const app = express()
  app.set('trust proxy', true) // makes req.ip the forwarded address, which must still never be logged
  app.use(observe({ service: 'synthetic-api', route: { mounts: ['/accounts/:accountId'] } }))
  app.use(express.json())
  app.use((req, res, next) => {
    req.user = { id: SENTINELS.userId } // what an auth middleware typically adds
    next()
  })

  const accounts = express.Router()
  accounts.post('/profile/:profileId', (req, res) => {
    res.cookie('session', SENTINELS.cookie)
    res.json({ echo: SENTINELS.responseBody })
  })
  accounts.get('/fail/:profileId', () => {
    throw new Error(`failure involving ${SENTINELS.errorMessage}`)
  })
  app.use('/accounts/:accountId', accounts)
  return app
}

function sendRequest (agent, method, path) {
  return agent[method](path)
    .set('Authorization', `Bearer ${SENTINELS.bearer}`)
    .set('Cookie', `session=${SENTINELS.cookie}`)
    .set('X-Forwarded-For', SENTINELS.forwardedIp)
    .set('User-Agent', SENTINELS.userAgent)
    .set('X-Custom', SENTINELS.customHeader)
}

test('no planted sensitive value appears in stdout or stderr output, for success and error responses', async () => {
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const app = buildApp()
    const query = `?email=${encodeURIComponent(SENTINELS.email)}&q=${SENTINELS.query}`

    const ok = await sendRequest(request(app), 'post', `/accounts/${SENTINELS.mountParam}/profile/${SENTINELS.pathParam}${query}`)
      .send({ password: SENTINELS.password, note: SENTINELS.bodyField, email: SENTINELS.email })
    expect(ok.status).toBe(200)

    const failed = await sendRequest(request(app), 'get', `/accounts/${SENTINELS.mountParam}/fail/${SENTINELS.pathParam}${query}`)
    expect(failed.status).toBe(500)

    await sleep(50)

    const written = [
      ...stdout.mock.calls.map((args) => String(args[0])),
      ...stderr.mock.calls.map((args) => String(args[0]))
    ].join('')

    const lines = stdout.mock.calls.map((args) => String(args[0])).filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(2)
    const records = lines.map((l) => JSON.parse(l))
    for (const record of records) expect(Object.keys(record)).toEqual(RECORD_KEYS)
    expect(records.map((r) => r.route)).toEqual([
      '/accounts/:accountId/profile/:profileId',
      '/accounts/:accountId/fail/:profileId'
    ])

    for (const [where, value] of Object.entries(SENTINELS)) {
      expect({ where, leaked: written.includes(value) }).toEqual({ where, leaked: false })
    }
    // Also check URL-encoded forms and the raw query marker.
    expect(written).not.toContain(encodeURIComponent(SENTINELS.email))
    expect(written).not.toContain('?')
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
})
