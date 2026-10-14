'use strict'

const express = require('express')
const request = require('supertest')
const observe = require('../src')
const { collectingSink } = require('./helpers/records')

const EXPRESS_MAJOR = Number(require('express/package.json').version.split('.')[0])

/** Run one request and return its record. */
async function routeFor (configure, path, options = {}) {
  const collector = collectingSink()
  const app = express()
  app.use(observe({ ...options, log: { sink: collector.sink } }))
  configure(app)
  await request(app).get(path)
  const [record] = await collector.waitFor(1)
  return record
}

/** The serialized record must not contain any concrete path value used in the request. */
function expectNoValues (record, values) {
  const json = JSON.stringify(record)
  for (const value of values) expect(json).not.toContain(value)
}

function postsRouter () {
  const router = express.Router()
  router.get('/', (req, res) => res.send('list'))
  router.get('/:postId', (req, res) => res.send('one'))
  return router
}

describe('route templates: top-level routes', () => {
  test('a parameterized route is logged as its template, never the concrete path', async () => {
    const record = await routeFor((app) => app.get('/users/:id', (req, res) => res.send('ok')), '/users/48151623')
    expect(record.route).toBe('/users/:id')
    expectNoValues(record, ['48151623'])
  })

  // Inline regex parameters exist only in Express 4 (path-to-regexp 0.1); Express 5 rejects them.
  const testExpress4 = EXPRESS_MAJOR === 4 ? test : test.skip
  const testExpress5 = EXPRESS_MAJOR >= 5 ? test : test.skip

  testExpress4('Express 4: several params and an inline regex constraint are kept as written', async () => {
    const record = await routeFor(
      (app) => app.get('/orgs/:orgId/files/:name(\\w+)', (req, res) => res.send('ok')),
      '/orgs/7700131/files/report'
    )
    expect(record.route).toBe('/orgs/:orgId/files/:name(\\w+)')
    expectNoValues(record, ['7700131', 'report'])
  })

  testExpress5('Express 5: a named wildcard is kept as written, never the matched path', async () => {
    const record = await routeFor(
      (app) => app.get('/files/*splat', (req, res) => res.send('ok')),
      '/files/secret-dir/8812391/report.pdf'
    )
    expect(record.route).toBe('/files/*splat')
    expectNoValues(record, ['secret-dir', '8812391', 'report.pdf'])
  })

  testExpress5('Express 5: an optional segment is kept as written', async () => {
    const record = await routeFor(
      (app) => app.get('/orgs/:orgId/files/:name{.:ext}', (req, res) => res.send('ok')),
      '/orgs/7700131/files/report.pdf'
    )
    expect(record.route).toBe('/orgs/:orgId/files/:name{.:ext}')
    expectNoValues(record, ['7700131', 'report'])
  })

  test('a RegExp route has no safe template: null', async () => {
    const record = await routeFor((app) => app.get(/^\/re\/\d+$/, (req, res) => res.send('ok')), '/re/9021077')
    expect(record.route).toBeNull()
    expectNoValues(record, ['9021077'])
  })

  test('an array route has no single template: null', async () => {
    const record = await routeFor((app) => app.get(['/a/:x', '/b/:x'], (req, res) => res.send('ok')), '/a/31337')
    expect(record.route).toBeNull()
  })

  test('a response produced by plain middleware (no route matched) is null', async () => {
    const record = await routeFor((app) => app.use('/health', (req, res) => res.send('ok')), '/health')
    expect(record.route).toBeNull()
  })

  test('query strings never reach the route', async () => {
    const record = await routeFor(
      (app) => app.get('/search', (req, res) => res.send('ok')),
      '/search?q=private-term&token=abc123'
    )
    expect(record.route).toBe('/search')
    expectNoValues(record, ['private-term', 'abc123'])
  })
})

describe('route templates: nested routers', () => {
  test('a router at a parameterized mount without mounts config yields null (baseUrl is concrete)', async () => {
    const record = await routeFor(
      (app) => app.use('/users/:userId/posts', postsRouter()),
      '/users/5550123/posts/8675309'
    )
    expect(record.route).toBeNull()
    expectNoValues(record, ['5550123', '8675309'])
  })

  test('the same request with the mount template configured yields the full template', async () => {
    const record = await routeFor(
      (app) => app.use('/users/:userId/posts', postsRouter()),
      '/users/5550123/posts/8675309',
      { route: { mounts: ['/users/:userId/posts'] } }
    )
    expect(record.route).toBe('/users/:userId/posts/:postId')
    expectNoValues(record, ['5550123', '8675309'])
  })

  test("a router's '/' route is labelled with the mount template, without a trailing slash", async () => {
    const record = await routeFor(
      (app) => app.use('/users/:userId/posts', postsRouter()),
      '/users/5550123/posts',
      { route: { mounts: ['/users/:userId/posts'] } }
    )
    expect(record.route).toBe('/users/:userId/posts')
  })

  test('a static mount also needs a mounts entry; without it the label is null', async () => {
    const configure = (app) => app.use('/api', postsRouter())
    expect((await routeFor(configure, '/api/12')).route).toBeNull()
    expect((await routeFor(configure, '/api/12', { route: { mounts: ['/api'] } })).route).toBe('/api/:postId')
  })

  test('literal segments match case-insensitively, like Express 4 routing; the template spelling is logged', async () => {
    const record = await routeFor(
      (app) => app.use('/api', postsRouter()),
      '/API/12',
      { route: { mounts: ['/api'] } }
    )
    expect(record.route).toBe('/api/:postId')
  })

  test('with several same-length mount templates, only the one whose literals match is used', async () => {
    const configure = (app) => {
      app.use('/v1', postsRouter())
      app.use('/v2', postsRouter())
      app.use('/v3', postsRouter())
    }
    const options = { route: { mounts: ['/v1', '/v2'] } }
    expect((await routeFor(configure, '/v2/12', options)).route).toBe('/v2/:postId')
    expect((await routeFor(configure, '/v3/12', options)).route).toBeNull()
  })

  test('two levels of nesting need the full mount path', async () => {
    const configure = (app) => {
      const teams = express.Router()
      teams.use('/teams/:teamId', postsRouter())
      app.use('/orgs/:orgId', teams)
    }
    const partial = await routeFor(configure, '/orgs/1001731/teams/2002731/3003731', { route: { mounts: ['/orgs/:orgId'] } })
    expect(partial.route).toBeNull()

    const full = await routeFor(configure, '/orgs/1001731/teams/2002731/3003731', {
      route: { mounts: ['/orgs/:orgId', '/orgs/:orgId/teams/:teamId'] }
    })
    expect(full.route).toBe('/orgs/:orgId/teams/:teamId/:postId')
    expectNoValues(full, ['1001731', '2002731', '3003731'])
  })

  test('next(err) out of a nested router keeps the nested label (baseUrl is captured at match time)', async () => {
    const record = await routeFor((app) => {
      const router = express.Router()
      router.get('/items/:itemId', (req, res, next) => next(new Error('synthetic failure')))
      app.use('/api', router)
      app.use((err, req, res, _next) => res.status(500).send('error'))
    }, '/api/items/7', { route: { mounts: ['/api'] } })
    expect(record).toMatchObject({ status: 500, route: '/api/items/:itemId' })
  })
})

describe('route templates: route capture does not leak into shared prototypes', () => {
  const http = require('node:http')

  test('express.request and http.IncomingMessage.prototype never get a route property', async () => {
    await routeFor((app) => app.get('/users/:id', (req, res) => res.send('ok')), '/users/1')

    // observe() used without Express: the request prototype is IncomingMessage.prototype itself.
    const collector = collectingSink()
    const mw = observe({ log: { sink: collector.sink } })
    const server = http.createServer((req, res) => mw(req, res, () => res.end('plain')))
    await request(server).get('/plain')
    const [record] = await collector.waitFor(1)
    expect(record.route).toBeNull()

    expect(Object.prototype.hasOwnProperty.call(express.request, 'route')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(http.IncomingMessage.prototype, 'route')).toBe(false)
  })

  test('handlers and later middleware still read req.route as Express set it', async () => {
    let seen = null
    const record = await routeFor((app) => {
      app.get('/users/:id', (req, res, next) => { seen = req.route.path; next() }, (req, res) => res.json({ path: req.route.path }))
    }, '/users/1')
    expect(seen).toBe('/users/:id')
    expect(record.route).toBe('/users/:id')
  })

  test('two apps in one process keep their own labels', async () => {
    const a = await routeFor((app) => app.get('/a/:id', (req, res) => res.send('a')), '/a/1')
    const b = await routeFor((app) => app.get('/b/:id', (req, res) => res.send('b')), '/b/2')
    expect([a.route, b.route]).toEqual(['/a/:id', '/b/:id'])
  })

  test('a route inside a mounted sub-app is labelled through route.mounts', async () => {
    const record = await routeFor((app) => {
      const admin = express()
      admin.get('/users/:userId', (req, res) => res.send('admin'))
      app.use('/admin', admin)
    }, '/admin/users/7731904', { route: { mounts: ['/admin'] } })
    expect(record.route).toBe('/admin/users/:userId')
    expectNoValues(record, ['7731904'])
  })

  test('observe() registered inside a route still labels the request', async () => {
    const collector = collectingSink()
    const app = express()
    app.get('/users/:id', observe({ log: { sink: collector.sink } }), (req, res) => res.send('ok'))
    await request(app).get('/users/1')
    await request(app).get('/users/2')
    const records = await collector.waitFor(2)
    expect(records.map((r) => r.route)).toEqual(['/users/:id', '/users/:id'])
  })

  test('an app whose request prototype already defines route is left alone', async () => {
    let appRef
    const record = await routeFor((app) => {
      appRef = app
      Object.defineProperty(app.request, 'route', { configurable: true, enumerable: true, writable: true, value: undefined })
      app.get('/users/:id', (req, res) => res.send('ok'))
    }, '/users/1')
    expect(record.route).toBe('/users/:id')
    const descriptor = Object.getOwnPropertyDescriptor(appRef.request, 'route')
    expect(descriptor).toMatchObject({ writable: true, enumerable: true })
    expect(descriptor.get).toBeUndefined()
  })
})

describe('route templates: explicit labels', () => {
  test('res.locals.observeRoute overrides automatic detection', async () => {
    const record = await routeFor((app) => {
      app.use('/legacy', (req, res) => {
        res.locals.observeRoute = '/legacy/*'
        res.send('ok')
      })
    }, '/legacy/anything/123')
    expect(record.route).toBe('/legacy/*')
  })

  test('route.resolver can label requests; returning a non-string falls back to automatic detection', async () => {
    const resolver = (req) => (req.baseUrl === '/static' ? '/static/*' : undefined)
    const configure = (app) => {
      app.use('/static', (req, res) => res.send('file'))
      app.get('/users/:id', (req, res) => res.send('ok'))
    }
    expect((await routeFor(configure, '/static/a.css', { route: { resolver } })).route).toBe('/static/*')
    expect((await routeFor(configure, '/users/1', { route: { resolver } })).route).toBe('/users/:id')
  })

  test('res.locals.observeRoute wins over route.resolver', async () => {
    const record = await routeFor((app) => {
      app.get('/x', (req, res) => {
        res.locals.observeRoute = '/from-locals'
        res.send('ok')
      })
    }, '/x', { route: { resolver: () => '/from-resolver' } })
    expect(record.route).toBe('/from-locals')
  })

  test('a throwing resolver falls back to automatic detection and does not affect the response', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const record = await routeFor(
        (app) => app.get('/users/:id', (req, res) => res.send('ok')),
        '/users/1',
        { route: { resolver: () => { throw new Error('resolver bug') } } }
      )
      expect(record).toMatchObject({ status: 200, route: '/users/:id' })
    } finally {
      stderr.mockRestore()
    }
  })

  test('labels that are not short printable strings are ignored', async () => {
    const record = await routeFor((app) => {
      app.get('/users/:id', (req, res) => {
        res.locals.observeRoute = 'line\nbreak'
        res.send('ok')
      })
    }, '/users/1')
    expect(record.route).toBe('/users/:id')
  })
})

describe('route options validation', () => {
  test.each([
    ['mounts not an array', { mounts: '/api' }],
    ['mount without leading slash', { mounts: ['api'] }],
    ['wildcard mount', { mounts: ['/files/*'] }],
    ['optional param mount', { mounts: ['/a/:b?'] }],
    ['root mount', { mounts: ['/'] }],
    ['resolver not a function', { resolver: '/x' }],
    ['unknown route key', { strict: true }]
  ])('throws for %s', (_label, route) => {
    expect(() => observe({ route })).toThrow(TypeError)
  })
})
