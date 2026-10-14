'use strict'

const http = require('node:http')
const express = require('express')
const request = require('supertest')
const observe = require('../src')

// These tests are about headers, not logging: keep the default stdout sink from flooding the test output.
beforeAll(() => { jest.spyOn(process.stdout, 'write').mockImplementation(() => true) })
afterAll(() => { jest.restoreAllMocks() })
const { listen, rawRequest, rawHeaderValues, rawStatus } = require('./helpers/http')

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** App that echoes the request ID its handlers see, so tests can compare it with the response header. */
function echoApp (options, before) {
  const app = express()
  if (before) app.use(before)
  app.use(observe(options))
  app.get('/', (req, res) => res.json({ id: req.id }))
  return app
}

describe('request ID: generation and exposure', () => {
  test('generates a UUID v4, exposes it as req.id and returns it in X-Request-Id', async () => {
    const res = await request(echoApp()).get('/')
    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toMatch(UUID_V4)
    expect(res.body.id).toBe(res.headers['x-request-id'])
  })

  test('sets X-Request-Id on unmatched routes (404) and on error responses', async () => {
    const app = express()
    app.use(observe())
    app.get('/boom', () => { throw new Error('synthetic failure') })

    const notFound = await request(app).get('/nope')
    expect(notFound.status).toBe(404)
    expect(notFound.headers['x-request-id']).toMatch(UUID_V4)

    const failed = await request(app).get('/boom')
    expect(failed.status).toBe(500)
    expect(failed.headers['x-request-id']).toMatch(UUID_V4)
  })

  test('1000 concurrent requests receive 1000 distinct IDs, each matching what the handler saw', async () => {
    const { port, close } = await listen(echoApp())
    const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
    try {
      const results = await Promise.all(Array.from({ length: 1000 }, () => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve({ header: res.headers['x-request-id'], seen: JSON.parse(body).id }))
        }).on('error', reject)
      })))

      const headers = results.map((r) => r.header)
      expect(new Set(headers).size).toBe(1000)
      for (const r of results) {
        expect(r.header).toMatch(UUID_V4)
        expect(r.seen).toBe(r.header)
      }
    } finally {
      agent.destroy()
      await close()
    }
  })
})

describe('request ID: incoming header trust policy', () => {
  test('ignores a valid incoming ID by default (trustIncoming: false)', async () => {
    const res = await request(echoApp()).get('/').set('X-Request-Id', 'client-chosen-id')
    expect(res.headers['x-request-id']).toMatch(UUID_V4)
    expect(res.body.id).toBe(res.headers['x-request-id'])
  })

  test('accepts a valid incoming ID when trustIncoming is true', async () => {
    const res = await request(echoApp({ requestId: { trustIncoming: true } }))
      .get('/')
      .set('X-Request-Id', 'abc.DEF_123-xyz')
    expect(res.headers['x-request-id']).toBe('abc.DEF_123-xyz')
    expect(res.body.id).toBe('abc.DEF_123-xyz')
  })

  test('accepts an incoming ID of exactly 128 characters', async () => {
    const id = 'a'.repeat(128)
    const res = await request(echoApp({ requestId: { trustIncoming: true } })).get('/').set('X-Request-Id', id)
    expect(res.headers['x-request-id']).toBe(id)
  })

  const invalidIds = [
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['10 KB', 'b'.repeat(10 * 1024)],
    ['whitespace', 'has space'],
    ['tab', 'tab\tinside'],
    ['comma (looks like a joined duplicate)', 'one,two'],
    ['double quote', 'quote"d'],
    ['markup', '<script>alert(1)</script>'],
    ['path traversal', '../../etc/passwd'],
    ['latin1 non-ASCII', 'café'],
    ['JSON fragment', '{"admin":true}']
  ]

  test.each(invalidIds)('replaces an invalid incoming ID (%s) without failing the request', async (_label, value) => {
    const res = await request(echoApp({ requestId: { trustIncoming: true } })).get('/').set('X-Request-Id', value)
    expect(res.status).toBe(200)
    expect(res.headers['x-request-id']).toMatch(UUID_V4)
    expect(res.body.id).toBe(res.headers['x-request-id'])
  })

  test('replaces UTF-8 multi-byte input sent as raw bytes over a socket', async () => {
    const { port, close } = await listen(echoApp({ requestId: { trustIncoming: true } }))
    try {
      const head = Buffer.concat([
        Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Request-Id: '),
        Buffer.from('id-\u{1F600}', 'utf8'),
        Buffer.from('\r\n\r\n')
      ])
      const text = await rawRequest(port, head)
      expect(rawStatus(text)).toBe(200)
      expect(rawHeaderValues(text, 'X-Request-Id')[0]).toMatch(UUID_V4)
    } finally {
      await close()
    }
  })

  test('replaces the ID when the client sends the header twice', async () => {
    const { port, close } = await listen(echoApp({ requestId: { trustIncoming: true } }))
    try {
      const text = await rawRequest(
        port,
        'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Request-Id: first\r\nX-Request-Id: second\r\n\r\n'
      )
      expect(rawStatus(text)).toBe(200)
      const values = rawHeaderValues(text, 'X-Request-Id')
      expect(values).toHaveLength(1)
      expect(values[0]).toMatch(UUID_V4)
    } finally {
      await close()
    }
  })

  test('a trustIncoming function decides per request', async () => {
    const app = echoApp({ requestId: { trustIncoming: (req) => req.headers['x-synthetic-proxy'] === 'yes' } })

    const trusted = await request(app).get('/').set('X-Synthetic-Proxy', 'yes').set('X-Request-Id', 'from-proxy')
    expect(trusted.headers['x-request-id']).toBe('from-proxy')

    const untrusted = await request(app).get('/').set('X-Request-Id', 'from-proxy')
    expect(untrusted.headers['x-request-id']).toMatch(UUID_V4)
  })

  test('a throwing trustIncoming function is treated as untrusted, warns without leaking the message', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const app = echoApp({
        requestId: {
          trustIncoming: () => { throw new TypeError('secret-token-123 should never be printed') }
        }
      })
      const res = await request(app).get('/').set('X-Request-Id', 'from-client')
      expect(res.status).toBe(200)
      expect(res.headers['x-request-id']).toMatch(UUID_V4)

      const output = stderr.mock.calls.map((args) => String(args[0])).join('')
      expect(output).toContain('trustIncoming')
      expect(output).toContain('TypeError')
      expect(output).not.toContain('secret-token-123')
    } finally {
      stderr.mockRestore()
    }
  })

  test('a custom header name is read and written instead of X-Request-Id', async () => {
    const app = echoApp({ requestId: { header: 'X-Correlation-Id', trustIncoming: true } })
    const res = await request(app).get('/').set('X-Correlation-Id', 'corr-1')
    expect(res.headers['x-correlation-id']).toBe('corr-1')
    expect(res.headers['x-request-id']).toBeUndefined()
    expect(res.body.id).toBe('corr-1')
  })
})

describe('request ID: existing req.id', () => {
  const setUpstreamId = (value) => (req, _res, next) => { req.id = value; next() }

  test('keeps a valid req.id set by an earlier middleware and returns it in the header', async () => {
    const res = await request(echoApp(undefined, setUpstreamId('upstream-42'))).get('/')
    expect(res.body.id).toBe('upstream-42')
    expect(res.headers['x-request-id']).toBe('upstream-42')
  })

  test("existing req.id wins over a trusted incoming header under 'keep'", async () => {
    const app = echoApp({ requestId: { trustIncoming: true } }, setUpstreamId('upstream-42'))
    const res = await request(app).get('/').set('X-Request-Id', 'from-client')
    expect(res.body.id).toBe('upstream-42')
  })

  test("onExistingId: 'replace' overwrites req.id", async () => {
    const res = await request(echoApp({ requestId: { onExistingId: 'replace' } }, setUpstreamId('upstream-42'))).get('/')
    expect(res.body.id).toMatch(UUID_V4)
    expect(res.headers['x-request-id']).toBe(res.body.id)
  })

  test('an existing req.id that is not a valid ID string is replaced so header and req.id agree', async () => {
    const res = await request(echoApp(undefined, setUpstreamId(42))).get('/')
    expect(res.body.id).toMatch(UUID_V4)
    expect(res.headers['x-request-id']).toBe(res.body.id)
  })

  test('mounting observe() twice yields one ID', async () => {
    const app = express()
    app.use(observe())
    app.use(observe())
    app.get('/', (req, res) => res.json({ id: req.id }))
    const res = await request(app).get('/')
    expect(res.headers['x-request-id']).toBe(res.body.id)
  })
})

describe('options validation (fails at startup, never per request)', () => {
  test.each([
    ['non-object options', 'yes'],
    ['unknown top-level key', { sampling: 0.5 }],
    ['unknown requestId key', { requestId: { generator: () => 'x' } }],
    ['invalid header name', { requestId: { header: 'X Request Id' } }],
    ['trustIncoming string', { requestId: { trustIncoming: 'true' } }],
    ['onExistingId value', { requestId: { onExistingId: 'merge' } }],
    ['serverTiming.enabled string', { serverTiming: { enabled: 'no' } }],
    ['serverTiming.maxEntries zero', { serverTiming: { maxEntries: 0 } }],
    ['serverTiming.maxEntries too large', { serverTiming: { maxEntries: 1000 } }],
    ['empty service', { service: '' }],
    ['numeric release', { release: 3 }]
  ])('throws a TypeError for %s', (_label, options) => {
    expect(() => observe(options)).toThrow(TypeError)
  })

  test('accepts no options and the documented shape', () => {
    expect(typeof observe()).toBe('function')
    expect(typeof observe({
      service: 'synthetic-api',
      release: '0.0.1',
      requestId: { header: 'X-Request-Id', trustIncoming: false, onExistingId: 'keep' },
      serverTiming: { enabled: true, maxEntries: 16 }
    })).toBe('function')
  })
})
