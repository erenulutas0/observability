# express-observe

Lightweight, privacy-first observability middleware for Express 4.

One `app.use()` gives every request:

- a **request ID** in `req.id` and the `X-Request-Id` response header,
- a standards-based **`Server-Timing`** header, with an optional API for your own timers,
- exactly **one structured access-log record** when the response finishes or the connection is interrupted.

It is a small building block that feeds the logging you already have. It is not a tracing system, an APM agent or a metrics server, and it does not replace OpenTelemetry, Sentry or Pino.

> **Status: 0.1.0-dev, not published.** The behaviour below is covered by tests, but the package has not been used in production. Do not treat passing tests as a production-readiness claim.

## Requirements

- Node.js 22 or later
- Express 4.17 or later (tested with 4.22.3). Express 5 is not supported yet.
- Runtime dependencies: [`on-headers`](https://www.npmjs.com/package/on-headers) 1.1 and [`on-finished`](https://www.npmjs.com/package/on-finished) 2.4, both from the Express maintainers.

## Quick start

```js
const express = require('express')
const observe = require('express-observe')

const app = express()

app.use(observe({
  service: 'orders-api',
  release: process.env.RELEASE ?? null,
}))

app.get('/users/:id', async (req, res) => {
  res.serverTiming.start('db')
  const user = await loadUser(req.params.id)
  res.serverTiming.end('db')
  res.json(user)
})
```

Register it **before** your routes and other middleware, so its clock starts first and every response passes through it.

With `RELEASE=1.4.2`, a request to `/users/42?token=abc` returns headers like these (durations vary):

```http
X-Request-Id: 0b1c0f8e-2b7a-4d1e-9c3a-7f6e5d4c3b2a
Server-Timing: db;dur=12.3, app;dur=14.0
```

and writes one line to stdout:

```json
{"schemaVersion":1,"timestamp":"2026-10-14T07:20:07.947Z","requestId":"0b1c0f8e-2b7a-4d1e-9c3a-7f6e5d4c3b2a","requestIdSource":"generated","service":"orders-api","release":"1.4.2","method":"GET","route":"/users/:id","status":200,"headerDurationMs":14.012,"durationMs":15.3,"termination":"finished"}
```

Note what is missing: no `42`, no `token=abc`, no headers, no IP.

## The access-log record

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Bumped on any incompatible change to this table |
| `timestamp` | string | ISO 8601 UTC wall-clock time when the response terminated |
| `requestId` | string | The ID returned in the response header |
| `requestIdSource` | `"generated"` \| `"client"` \| `"existing"` | Where the ID came from. A client-supplied ID is correlation data, not identity, and is not guaranteed unique |
| `service`, `release` | string \| null | From options |
| `method` | string | HTTP method |
| `route` | string \| null | Route **template** such as `/users/:id`. `null` when it cannot be determined safely. Never a raw URL |
| `status` | number \| null | Status code that was actually sent. `null` if the connection ended before headers were sent |
| `headerDurationMs` | number \| null | Middleware entry until response headers were written. `null` if they never were |
| `durationMs` | number | Middleware entry until the response finished or the connection ended |
| `termination` | `"finished"` \| `"interrupted"` | `finished`: the last byte was handed to the operating system. `interrupted`: the connection ended first |

Durations use a monotonic clock and have three decimals.

### Reading the numbers

| Name | Measured by | From, to | It is **not** |
|---|---|---|---|
| `headerDurationMs`, `app;dur` | server | middleware entry, header write | total request time |
| `durationMs` | server | middleware entry, finish or early close | the time the client waited. `finish` does not mean the client received the data |
| your `name;dur` | server | `start(name)`, `end(name)` | a share of the total. Parallel work can add up to more than `durationMs` |
| `termination: "interrupted"` | server | | proof that a user cancelled. Proxies, timeouts and network failures look the same |

Two rules follow:

- **A request still in progress has no record yet.** No log line does not mean no request.
- **Client time minus server time is not "network time".** The two clocks start and stop at different points.

`headerDurationMs` and `durationMs` together separate a request that was slow before its first byte from one whose body took long. The [diagnostic-lab demo](../../demo/README.md) shows both side by side.

## Options

All options are optional. Invalid or unknown options throw a `TypeError` when `observe()` is called, at startup, never during a request.

```js
observe({
  service: null,                  // string, up to 256 characters
  release: null,                  // string, up to 256 characters
  requestId: {
    header: 'X-Request-Id',       // header read from the request and written to the response
    trustIncoming: false,         // boolean | (req) => boolean
    onExistingId: 'keep',         // 'keep' | 'replace'
  },
  serverTiming: {
    enabled: true,
    maxEntries: 16,               // 1 to 64 custom metrics per response
  },
  route: {
    mounts: [],                   // mount templates for routers, e.g. ['/api', '/users/:userId/posts']
    resolver: null,               // (req, res) => string | undefined
  },
  log: {
    enabled: true,
    sink: null,                   // (record) => void | Promise; default: one JSON line on stdout
    onSinkError: null,            // (err, record) => void; default: rate-limited stderr warning
    extend: null,                 // (req, res) => object; extra fields, opt-in
  },
})
```

### Request IDs

- New IDs come from `crypto.randomUUID()`.
- By default an incoming `X-Request-Id` is **ignored**: anyone on the network could otherwise choose the ID that appears in your logs. Set `trustIncoming: true`, or pass a function such as `(req) => req.socket.remoteAddress === '10.0.0.5'`, when a trusted proxy or your own client sets it.
- A trusted incoming ID is used only if it is 1 to 128 characters of `A-Z a-z 0-9 . _ -`. Anything else, including a header sent twice, is silently replaced by a new ID. The request is never rejected.
- If an earlier middleware already set a valid string `req.id`, it is kept and echoed (`onExistingId: 'keep'`). Use `'replace'` to always assign a new one.
- A `trustIncoming` function that throws counts as "not trusted".

### Server-Timing

`res.serverTiming` is always present, even when disabled, so your code never needs a feature check.

| Call | Behaviour |
|---|---|
| `start(name)` | Starts a timer. Calling it again for a running name restarts it |
| `end(name)` | Stops the timer. Ignored if the timer is not running. A second measurement of the same name replaces the first |
| `add(name, durationMs, desc?)` | Records a duration you measured yourself, with an optional description |

- Names are 1 to 32 characters of `A-Z a-z 0-9 _ -`. `app` is reserved for the built-in metric. Invalid names, invalid durations and names beyond `maxEntries` are ignored.
- `desc` keeps printable ASCII only, is cut to 64 characters, and is quoted and escaped.
- The header is written at the moment headers are sent. Timers still running then, and calls made afterwards (for example while streaming a body), do not appear. None of these calls ever throws.
- A `Server-Timing` value your app or a proxy library already set is kept and extended.
- Browsers expose `Server-Timing` to cross-origin JavaScript only with a `Timing-Allow-Origin` header, which this package does not set. Native mobile clients read the header directly.
- Do not put secrets in metric names or descriptions: every client can read this header.

### Route labels

Express knows the pattern of the matched route, but for routers it only knows the **concrete** mount prefix: for `app.use('/users/:userId/posts', router)` a request gets `req.baseUrl === '/users/42/posts'`. Logging that would leak IDs, so this package never logs `baseUrl`. The label is resolved in this order:

1. `res.locals.observeRoute`, if your handler sets a string.
2. `route.resolver(req, res)`, if it returns a string.
3. The matched route pattern, when the route is registered directly on the app.
4. For routers: the mount template from `route.mounts` that matches `req.baseUrl`, joined with the route pattern.
5. Otherwise `null`.

**Every router mount needs a `mounts` entry, static ones too:**

```js
app.use('/api', apiRouter)
app.use('/users/:userId/posts', postsRouter)

app.use(observe({ route: { mounts: ['/api', '/users/:userId/posts'] } }))
// GET /api/orders/7        -> "/api/orders/:orderId"
// GET /users/42/posts/9    -> "/users/:userId/posts/:postId"
```

- Mount templates support literal and `:param` segments; literals match case-insensitively, as Express does by default. Nested routers need the full prefix, for example `'/orgs/:orgId/teams/:teamId'`.
- A route answering 404 keeps its label. An unmatched URL gets `null`.
- RegExp routes, array routes and responses sent by plain middleware get `null` unless you label them.
- Labels must be printable ASCII and at most 256 characters; anything else is ignored.

### Sinks

The sink receives the record as an **object**. Serialization is the sink's job, which lets an existing logger keep its own format:

```js
const pino = require('pino')
const logger = pino()

app.use(observe({ log: { sink: (record) => logger.info(record) } }))
```

Your logger adds its own fields on top of the record. Pino, for example, adds `level`, `time`, `pid` and `hostname` by default; configure its `base` option if you do not want the host name in every line.

- A sink that throws, or returns a promise that rejects, never affects the response or later records. The failure goes to `onSinkError(err, record)`. Without one, a single stderr line naming the error class is written at most every 10 seconds; error messages are never printed.
- The sink runs after the response has ended, so a slow **asynchronous** sink does not delay responses. A sink that blocks synchronously still slows the whole process.
- There is no buffering, no retry and no flush on exit. Records can be lost when the process exits or the sink fails.

### Adding fields

`log.extend` is the only way to add fields, and you own what you add:

```js
observe({ log: { extend: (req, res) => ({ tenant: res.locals.tenantId }) } })
```

Core fields always win, so an extension cannot overwrite `status`, `route` or `requestId`. An extension that throws or does not return an object is ignored and the core record is still written.

## Analyzing logs

The package ships a command-line tool that summarizes the JSON lines it writes, without a dashboard or a cloud account:

```bash
npx express-observe analyze access.log
```

```text
METHOD-ROUTE           COUNT    5XX  INTERRUPTED  P50 MS  P95 MS  P99 MS  MAX MS  HEADER P95 MS
---------------------  -----  -----  -----------  ------  ------  ------  ------  -------------
GET /users/:id          4210   0.1%            3     4.2    18.9    61.0   412.7           17.8
POST /orders             812   1.2%            9    22.5    95.1   240.3   980.2           94.6
GET (unknown route)       77   0.0%            0     0.9     2.1       -     3.3            2.0
```

The numbers above are illustrative. Options:

| Option | Meaning |
|---|---|
| `--by method-route\|route\|service\|release` | Grouping (default `method-route`) |
| `--sort count\|p95\|p99\|errors\|interrupted` | Order of groups (default `count`) |
| `--top N` | Number of groups shown, `0` for all (default 20) |
| `--since`, `--until` | ISO 8601 time window |
| `--slowest N` | Also list the N slowest finished requests with their request IDs, to look them up |
| `--json` | Machine-readable report |

Use `-` to read stdin, for example `docker logs api | npx express-observe analyze -`. Lines that are not express-observe records are skipped and counted, and records wrapped by another logger such as pino are recognised.

What the report deliberately does:

- Latency percentiles use **finished** requests only. Interrupted requests are counted separately.
- p95 needs at least 20 values and p99 at least 100 in a group; with fewer they are shown as `-` instead of a misleading number.
- It ends with notes derived from the data: unknown routes, interruptions and what they do not prove, mixed services or releases, withheld percentiles.
- Text from the log is printed as plain ASCII, so a crafted log line cannot inject terminal escape codes.

Exit codes: `0` report printed, `1` unreadable input or no valid records, `2` usage error. The full report shape is in `--json`; `reportVersion` changes on incompatible updates.

## Privacy defaults

The middleware never writes request or response bodies, URLs or query strings, headers (including `Authorization`), cookies, IP addresses, user identifiers, error messages or stack traces. This is enforced by a test that plants sentinel values in each of those places and checks stdout and stderr.

What you add yourself through `extend`, `res.locals.observeRoute`, `route.resolver`, `service`, `release` or `Server-Timing` descriptions is your responsibility.

## Errors and interrupted connections

- Errors passed to `next(err)` reach your error middleware unchanged. The record shows the status your handler sent.
- If an error happens after headers were sent, Express closes the connection. The record shows `termination: "interrupted"` with the status that was sent.
- If the client disconnects before headers, the record has `status: null`. A later response from your handler does not create a second record.
- The middleware's own failures never reach your request pipeline.

## Known limitations

- **Express 4 does not catch rejected promises from `async` handlers.** Such a request hangs until the client gives up; only then is a record written, as `interrupted` with `status: null`. Catch errors yourself and call `next(err)`, or use a wrapper. Express 5 fixes this.
- **Express 4's default error handler prints the stack to stderr** whenever `NODE_ENV` is not `test`. That output comes from Express, not from this package. Install your own error middleware if stacks must stay out of stderr.
- **No delivery guarantee.** See Sinks.
- **`durationMs` starts when the middleware runs.** Connection setup, TLS and request-header parsing happen earlier and are not included.
- **Server-side only.** It cannot measure network latency, client rendering or device performance. It gives the client the IDs and timings it needs to correlate those itself.
- **Express 5** is not supported yet.

## Performance

The middleware costs CPU time on every request. One measurement on a Windows 11 desktop (Intel i5-12500, Node 22.23.2, Express 4.22.3), with a route that returns a tiny JSON body and logs written to a file, gave these medians of three 15-second runs:

| Configuration | Server CPU per request | Throughput vs no middleware |
|---|---|---|
| No middleware | 128 µs | baseline |
| Request ID and Server-Timing only | 194 µs | −36% |
| Everything on, default stdout sink | 287 µs | −55% |
| pino-http with a request ID, for comparison | 222 µs | −46% |

Read this as an upper bound for relative cost. The handler does almost nothing, so the middleware is a large share of each request; with handlers that do real work, the same tens of microseconds are a much smaller share. Background load made run-to-run spread wide. Method, ranges, latency percentiles and caveats are in [bench/](../../bench/README.md); run `npm run bench` to measure on your own machine.

## Not in scope

OpenTelemetry integration, distributed tracing, metrics endpoints, dashboards, automatic database instrumentation, sampling and profiling. Some may come later as separate, optional pieces.

## License

MIT
