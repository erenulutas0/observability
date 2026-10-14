'use strict'

const express = require('express')
const request = require('supertest')
const observe = require('../src')
const { sleep } = require('./helpers/http')
const { collectingSink, RECORD_KEYS } = require('./helpers/records')

function appWith (log) {
  const app = express()
  app.use(observe({ log }))
  app.get('/', (req, res) => res.send('ok'))
  return app
}

/** Capture stderr for the duration of fn and return what was written. */
async function captureStderr (fn) {
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await fn()
    return spy.mock.calls.map((args) => String(args[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

describe('default sink', () => {
  test('writes one JSON line per request to stdout', async () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const res = await request(appWith(undefined)).get('/')
      await sleep(50)
      const lines = stdout.mock.calls.map((args) => String(args[0]))
      expect(lines).toHaveLength(1)
      expect(lines[0].endsWith('\n')).toBe(true)
      const record = JSON.parse(lines[0])
      expect(Object.keys(record)).toEqual(RECORD_KEYS)
      expect(record.requestId).toBe(res.headers['x-request-id'])
    } finally {
      stdout.mockRestore()
    }
  })
})

describe('custom sink', () => {
  test('receives the record as an object, not a string', async () => {
    const sink = jest.fn()
    await request(appWith({ sink })).get('/')
    await sleep(50)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(typeof sink.mock.calls[0][0]).toBe('object')
  })

  test('a sink that throws does not change the response, and later records are still delivered', async () => {
    const delivered = []
    let calls = 0
    const onSinkError = jest.fn()
    const sink = (record) => {
      calls++
      if (calls === 1) throw new Error('sink down')
      delivered.push(record)
    }
    const app = appWith({ sink, onSinkError })
    const first = await request(app).get('/')
    const second = await request(app).get('/')
    await sleep(50)

    expect(first.status).toBe(200)
    expect(first.text).toBe('ok')
    expect(second.status).toBe(200)
    expect(onSinkError).toHaveBeenCalledTimes(1)
    const [err, failedRecord] = onSinkError.mock.calls[0]
    expect(err.message).toBe('sink down')
    expect(failedRecord.requestId).toBe(first.headers['x-request-id'])
    expect(delivered.map((r) => r.requestId)).toEqual([second.headers['x-request-id']])
  })

  test('an async sink that rejects is reported via onSinkError and causes no unhandled rejection', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const onSinkError = jest.fn()
      const res = await request(appWith({ sink: async () => { throw new Error('async sink down') }, onSinkError })).get('/')
      await sleep(50)
      expect(res.status).toBe(200)
      expect(onSinkError).toHaveBeenCalledTimes(1)
      expect(onSinkError.mock.calls[0][0].message).toBe('async sink down')
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('a slow async sink does not delay the response', async () => {
    let resolveSink
    const sinkDone = new Promise((resolve) => { resolveSink = resolve })
    const sink = () => new Promise((resolve) => setTimeout(() => { resolve(); resolveSink() }, 300))
    const started = Date.now()
    const res = await request(appWith({ sink })).get('/')
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(250)
    await sinkDone
  })

  test('without onSinkError, failures produce a rate-limited stderr warning without the error message', async () => {
    const app = appWith({ sink: () => { throw new Error('secret-sink-detail') } })
    const output = await captureStderr(async () => {
      for (let i = 0; i < 5; i++) await request(app).get('/')
      await sleep(50)
    })
    const lines = output.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('log sink failed')
    expect(lines[0]).toContain('Error')
    expect(output).not.toContain('secret-sink-detail')
  })

  test('an onSinkError that throws is contained', async () => {
    const app = appWith({
      sink: () => { throw new Error('sink down') },
      onSinkError: () => { throw new Error('handler down') }
    })
    let res
    const output = await captureStderr(async () => {
      res = await request(app).get('/')
      await sleep(50)
    })
    expect(res.status).toBe(200)
    expect(output).toContain('onSinkError threw')
  })
})

describe('log.extend', () => {
  function extendApp (extend) {
    const collector = collectingSink()
    const app = express()
    app.use(observe({ log: { sink: collector.sink, extend } }))
    app.get('/', (req, res) => {
      res.locals.tenant = 'tenant-a'
      res.send('ok')
    })
    return { app, ...collector }
  }

  test('adds opt-in fields to the record', async () => {
    const { app, waitFor } = extendApp((req, res) => ({ tenant: res.locals.tenant }))
    await request(app).get('/')
    const [record] = await waitFor(1)
    expect(record.tenant).toBe('tenant-a')
  })

  test('cannot overwrite core fields', async () => {
    const { app, waitFor } = extendApp(() => ({ status: 999, route: '/forged', requestId: 'forged', extra: 1 }))
    const res = await request(app).get('/')
    const [record] = await waitFor(1)
    expect(record).toMatchObject({ status: 200, route: '/', requestId: res.headers['x-request-id'], extra: 1 })
  })

  test('a throwing extend still emits the core record', async () => {
    const { app, waitFor } = extendApp(() => { throw new Error('extend bug') })
    const output = await captureStderr(async () => {
      await request(app).get('/')
      await waitFor(1)
    })
    expect(output).toContain('log.extend threw')
  })

  test('a non-object return value is ignored', async () => {
    const { app, waitFor } = extendApp(() => 'not an object')
    await request(app).get('/')
    const [record] = await waitFor(1)
    expect(Object.keys(record)).toEqual(RECORD_KEYS)
  })

  test('a value the default sink cannot serialize is reported, not thrown', async () => {
    const app = express()
    const onSinkError = jest.fn()
    app.use(observe({ log: { extend: () => ({ big: 10n }), onSinkError } }))
    app.get('/', (req, res) => res.send('ok'))
    const res = await request(app).get('/')
    await sleep(50)
    expect(res.status).toBe(200)
    expect(onSinkError).toHaveBeenCalledTimes(1)
    expect(onSinkError.mock.calls[0][0]).toBeInstanceOf(TypeError)
  })
})

describe('log options validation', () => {
  test.each([
    ['sink not a function', { sink: 'stdout' }],
    ['onSinkError not a function', { onSinkError: true }],
    ['extend not a function', { extend: { tenant: 'a' } }],
    ['enabled not a boolean', { enabled: 'yes' }],
    ['unknown log key', { level: 'info' }]
  ])('throws for %s', (_label, log) => {
    expect(() => observe({ log })).toThrow(TypeError)
  })
})
