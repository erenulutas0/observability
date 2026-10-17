# express-observe

Lightweight, privacy-first observability middleware for Express 4 and 5.

One `app.use()` gives every request:

- a **request ID** in `req.id` and the `X-Request-Id` response header,
- a standards-based **`Server-Timing`** header, with an optional API for your own timers,
- exactly **one structured access-log record** when the response finishes or the connection is interrupted.

It is a small building block that feeds the logging you already have. It is not a tracing system, an APM agent or a metrics server, and it does not replace OpenTelemetry, Sentry or Pino.

> **Status: 0.1.0-dev, not published.** The behaviour below is covered by tests, but the package has not been used in production. Do not treat passing tests as a production-readiness claim.

## Requirements

- Node.js 22 or later
- Express 4.17 or later, or Express 5. The full test suite runs against both (4.22.3 and 5.3.0).
- One runtime dependency: [`on-headers`](https://www.npmjs.com/package/on-headers) 1.1, from the Express maintainers.
- TypeScript is optional. The package ships hand-written type definitions; install `@types/express` 4.17 or 5.x as well.

### TypeScript

```ts
import express = require('express')
import observe = require('express-observe')

const app = express()
app.use(observe({ log: { sink: (record: observe.AccessLogRecord) => console.log(record.route, record.durationMs) } }))

app.get('/users/:id', (req, res) => {
  res.serverTiming?.start('db')
  res.json({ requestId: req.id })
})
```

- `req.id` and `res.serverTiming` are typed as optional, because the compiler cannot know whether `observe()` ran before a given handler. Use `?.` or check them once.
- `observe.AccessLogRecord`, `observe.Options` and the other exported types describe the record and the options below. Fields added with `log.extend` are typed as `unknown`.
- The definitions are checked against the packed package with TypeScript 5.9 and 7.0, on Express 4 and 5. They are written by hand, so report any mismatch with the runtime as a bug.

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
| `eventLoopDelayMs` | number \| null | **Only with `eventLoop.enabled`**, placed after `durationMs`. The largest event-loop delay the process saw from shortly before this request until its end; `null` while the sampler has no measurement yet. See [Event-loop delay](#event-loop-delay-opt-in) |

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
  eventLoop: {
    enabled: false,               // adds eventLoopDelayMs to every record
    resolutionMs: 20,             // sampling interval, 5 to 1000
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

- Each record is handed to the sink **once**. That is a delivery attempt, not delivery: a sink returning (or its promise resolving) does not mean a remote log platform has stored the record.
- A sink that throws, or returns a promise that rejects, never affects the response or later records. The failure goes to `onSinkError(err, record)`. Without one, a single stderr line naming the error class is written at most every 10 seconds; error messages are never printed.
- The sink runs after the response has ended, so a slow **asynchronous** sink does not delay responses. A sink that blocks synchronously still slows the whole process.
- There is no buffering, no retry and no flush on exit. Records can be lost when the process exits or the sink fails.

### Event-loop delay (opt-in)

When synchronous work blocks Node's event loop, requests that arrive meanwhile wait **before** `observe()` runs, so their `durationMs` cannot contain that wait. A request can look fast in the log while its client waited the whole block. Enable `eventLoop` to see it:

```js
app.use(observe({ eventLoop: { enabled: true } }))
```

- One `unref()`ed timer per middleware instance measures how late each tick fires. Each record gets `eventLoopDelayMs`: the **maximum** delay seen from one interval before the request entered the middleware until it ended, including a tick that is overdue at that moment. It does not use `perf_hooks.monitorEventLoopDelay`.
- Samples live in a ring buffer of the last 256 ticks (about 5 s at the default 20 ms). Nothing is reset when a request ends, so concurrent requests read the same samples without affecting each other, and several of them can report the same block.
- The value is `null`, not `0`, while the sampler has not completed a tick yet (typically the first request after start-up), because a block before the sampler started cannot be seen. Once it has a baseline, `0` means no delay above timer granularity was seen.
- It says the **process** was blocked for about that long around this request. In other words: it is the event-loop delay observed in this time window; it does not prove how long this request itself caused or suffered, and it cannot say which code blocked. It is never added to `durationMs` or subtracted from anything.
- Timer granularity limits it: on Windows timers are coarse (about 15 ms), so values under about 20 ms carry no information there.
- `analyze` shows a `LOOP MAX MS` column and a note when records carry the field.
- Cost: a timer callback every `resolutionMs` and a scan of a few samples per request. A first measurement could not separate it from noise (median +7 µs per request, higher in 7 of 12 rounds, on a noisy machine).

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
| `--by field:<name>` | Split each `METHOD route` by a field you add with `log.extend` (see below) |
| `--sort count\|p95\|p99\|errors\|interrupted` | Order of groups (default `count`) |
| `--top N` | Number of groups shown, `0` for all (default 20) |
| `--since`, `--until` | ISO 8601 time window |
| `--slowest N` | Also list the N slowest finished requests with their request IDs, to look them up |
| `--json` | Machine-readable report |

**Splitting a route by your own field.** Query strings are never logged, so `GET /feed?page=1` and `GET /feed?page=200` land in one group. If cost depends on such a parameter, add a coarse bucket yourself, never the raw value, and group by it:

```js
const bucket = (page) => (page <= 1 ? '1' : page <= 10 ? '2-10' : page <= 100 ? '11-100' : '>100')

app.use(observe({
  log: { extend: (req) => (req.path === '/feed' ? { pageBucket: bucket(Number(req.query.page) || 1) } : null) }
}))
```

```bash
npx express-observe analyze --by field:pageBucket access.log
```

Each group is then `GET /feed  pageBucket=11-100` and so on. Records without the field show as `pageBucket=(not set)`.

- Core record fields cannot be used this way.
- At most 50 distinct values are kept; the rest are grouped as `(other values)`, with a note that the field looks like an ID.
- The values are printed as they appear in your log, so keep them coarse and free of personal data.

Use `-` to read stdin, for example `docker logs api | npx express-observe analyze -`. Lines that are not express-observe records are skipped and counted, and records wrapped by another logger such as pino are recognised.

What the report deliberately does:

- Latency percentiles use **finished** requests only. Interrupted requests are counted separately.
- p95 needs at least 20 values and p99 at least 100 in a group; with fewer they are shown as `-` instead of a misleading number.
- It ends with notes derived from the data: unknown routes, interruptions and what they do not prove, mixed services or releases, withheld percentiles.
- It describes **the records in its input only**. If a pipeline sampled, filtered or lost records before they reached the file, counts and rates describe what is left, not all traffic. For example, keeping every error but one success in ten turns a 10% error rate into 53%. The report says so; it cannot correct for it.
- It reports its method (nearest-rank percentiles, minimum samples, finished requests only) in the header and in `--json` under `method`.
- Data-quality checks: lines are skipped and counted by reason, and some cases get their own note.
  - A truncated last line, from a log cut while it was being written.
  - Records with another `schemaVersion`.
  - Records with malformed fields.
  - Input that looks like UTF-16, for example from Windows PowerShell 5 redirection. Convert such files to UTF-8.
  - A UTF-8 byte order mark is accepted.
- Text from the log is printed as plain ASCII, so a crafted log line cannot inject terminal escape codes.

Exit codes: `0` report printed, `1` unreadable input or no valid records, `2` usage error. The full report shape is in `--json`; `reportVersion` changes on incompatible updates.

## Checking an integration

`doctor` sends a few safe requests to your running server and checks how the middleware is wired in:

```bash
npx express-observe doctor http://127.0.0.1:3000 --path / --path /api/items/7 --log access.log
```

```text
express-observe doctor: http://127.0.0.1:3000 (6 GET requests, log: access.log)

PASS  reachable          6 of 6 probes answered
FAIL  request-id-header  missing or invalid on some responses
                         - GET /health: no X-Request-Id. observe() does not run for this path, or a middleware registered before it answered.
PASS  request-id-unique  5 distinct ID(s)
INFO  client-id-policy   not accepted: the server generated its own ID (the default)
PASS  server-timing      well-formed with an app entry on 6 response(s)
PASS  not-found-path     answered 404 with X-Request-Id
PASS  log-record-count   5 request(s), one record each
WARN  route-label        see details
                         - GET /api/items/7: answered 200 but the route is null. If a router serves it, add the router's mount template to route.mounts; if a middleware answered, set res.locals.observeRoute.
PASS  privacy-markers    this run's markers not found in the log (not a general privacy check)

Result: 1 failure(s), 1 warning(s).
```

The output above is illustrative. What it checks:

| Check | Catches |
|---|---|
| `request-id-header`, `not-found-path` | `observe()` registered too late, on a sub-path, or after a catch-all |
| `request-id-unique` | a cache or middleware replaying the same ID |
| `server-timing` | a missing or malformed header |
| `log-record-count` (`--log`) | records missing, or written twice by two sinks |
| `route-label` (`--log`) | routers missing from `route.mounts`, raw URLs used as labels |
| `privacy-markers` (`--log`) | this run's own random markers (sent in a query parameter and a header) reaching the log, for example through `extend` or another logger. A pass means only that these markers were not found; it is not proof that the log contains no personal data |

Safety limits, enforced before any request is sent:

- Only `localhost` and loopback addresses, unless you pass `--allow-remote`.
- Only `GET`, with no body, cookies or credentials, and redirects are not followed. Pass only paths that are safe to request repeatedly.
- At most 10 paths and 22 requests, one at a time, each with a hard time limit (`--timeout`, default 5 s). Response bodies are read up to 64 KiB.
- Requests carry `User-Agent: express-observe-doctor/<version>` and random marker values in a query parameter and a header. The log file is only read; its lines are never printed.

What each status means: `PASS` the check ran and found nothing; `FAIL` and `WARN` it found something, listed under the check; `INFO` a fact, not a judgement; `SKIP` the check was **not performed or was inconclusive** (no `--log`, no response to inspect, no probe that could be matched to a record). Doctor only sees HTTP responses and, with `--log`, the lines of that one file; it cannot see other sinks, other files or other processes.

Other options: `--header` for a custom request ID header, `--wait` before reading a buffered log, `--json`. Exit codes: `0` no failures (warnings allowed), `1` at least one failure, `2` usage error or refused target.

On Windows, Git Bash rewrites arguments that look like Unix paths, so `--path /api` arrives as `C:/Program Files/Git/api` and is rejected. Run doctor from PowerShell or cmd, or prefix the command with `MSYS_NO_PATHCONV=1` and give `--log` as a Windows path.

## Privacy defaults

The middleware never writes request or response bodies, URLs or query strings, headers (including `Authorization`), cookies, IP addresses, user identifiers, error messages or stack traces. This is enforced by a test that plants sentinel values in each of those places and checks stdout and stderr.

What you add yourself through `extend`, `res.locals.observeRoute`, `route.resolver`, `service`, `release` or `Server-Timing` descriptions is your responsibility.

## Local diagnostics

The access log cannot show requests that have not ended yet, or records that never reached your sink. `getDiagnostics()` returns the package's own counters, so you can check that from inside the process:

```js
const { getDiagnostics } = require('express-observe')

setInterval(() => logger.info({ expressObserve: getDiagnostics() }), 60_000).unref()
```

```json
{
  "schemaVersion": 1,
  "pid": 4242,
  "threadId": 0,
  "since": "2026-10-15T08:00:00.000Z",
  "requests": { "started": 120, "finished": 117, "interrupted": 1, "inFlight": 2 },
  "records": { "emitted": 118, "dropped": 0, "sinkErrors": 3, "sinkPending": 0 },
  "warnings": 3
}
```

| Counter | Meaning |
|---|---|
| `started` | Requests the middleware began observing. A second `observe()` on the same request does not count it again. |
| `finished`, `interrupted` | Requests that ended, by the same rule as the record's `termination`. |
| `inFlight` | `started − finished − interrupted` right now: requests that have no record yet. |
| `emitted` | Records handed to your sink. A delivery attempt, not proof of delivery. |
| `dropped` | Records that could not be built, so your sink was never called. Each one also raises a warning. |
| `sinkErrors` | Sink calls that threw or returned a promise that rejected. |
| `sinkPending` | Promises returned by your sink that have not settled yet. A number that keeps growing means your sink is stuck. |
| `warnings` | The package's internal warnings, including those whose stderr line was rate-limited. |

With logging enabled, once nothing is in flight: `finished + interrupted = emitted + dropped`.

- **Scope: this process, or this worker thread.** Every `observe()` instance in the process adds to the same counters. Each cluster worker, worker thread and process has its own, so do not present one as a total. `pid`, `threadId` and `since` say where a snapshot came from. A second copy of the package installed elsewhere in `node_modules` counts separately.
- **Counters only.** No reset: compare two snapshots. There are no per-route or per-status counters, no buffer, no timer, no HTTP endpoint and no process handlers. Publishing the snapshot is up to you.
- **Not a recovery mechanism.** Counters die with the process. Requests that never reached `observe()` are not counted. With `log.enabled: false` the request counters still work, and the record counters stay at zero.
- `diagnostic-lab --check` compares these counters with the records it received independently and fails if they disagree.

## Errors and interrupted connections

- Errors passed to `next(err)` reach your error middleware unchanged. The record shows the status your handler sent.
- If an error happens after headers were sent, Express closes the connection. The record shows `termination: "interrupted"` with the status that was sent.
- If the client disconnects before headers, the record has `status: null`. A later response from your handler does not create a second record.
- The middleware's own failures never reach your request pipeline.

## Known limitations

- **Express 4 does not catch rejected promises from `async` handlers.** What happens next depends on Node, not on this package. With Node 22's default (`--unhandled-rejections=throw`) the rejection is unhandled and **the process exits**: no record is written, and every request open in that process is cut off. If the application or its runtime keeps the process alive (for example `--unhandled-rejections=warn` or its own `unhandledRejection` handler), the request stays open until the client gives up and is then logged as `interrupted` with `status: null`. Catch errors yourself and call `next(err)`, or use a wrapper. Express 5 forwards a rejected promise *returned by a handler or middleware* to the error handler, and the request is logged as a finished 500; promises the handler does not return (timers, background work) are not covered. express-observe installs no global error handlers and is not an error-handling solution. Each case is tested in a separate Node process (`test/async-rejection-process.test.js`).
- **Express's default error handler prints the stack to stderr** (4 and 5) whenever `NODE_ENV` is not `test`. That output comes from Express, not from this package. Install your own error middleware if stacks must stay out of stderr.
- **No delivery guarantee.** See Sinks. `getDiagnostics()` shows sink failures and unsettled sink calls, but cannot show what happened after your sink returned.
- **`durationMs` starts when the middleware runs.** Connection setup, TLS and request-header parsing happen earlier and are not included.
- **Server-side only.** It cannot measure network latency, client rendering or device performance. It gives the client the IDs and timings it needs to correlate those itself.
- **Express 5 route syntax** (`/*splat`, `{.:ext}`) is logged as written. Express 4 inline regex parameters such as `:id(\d+)` are logged as written too. `route.mounts` templates support literal and `:param` segments only, so a router mounted on a wildcard path gets `route: null` unless you label it.

## Performance

The middleware costs CPU time on every request. Measured on 2026-10-15 on a Windows 11 desktop: Intel i5-12500, Node 22.23.2, Express 4.22.3. Logs went to a file. Each value is the median of five 30-second runs. Two handlers were measured:
- a **tiny** one, returning a small JSON body at once: the worst case;
- a **work** one, doing about 0.27 ms of CPU work first and returning 3 KB.

| Configuration | Extra server CPU per request, tiny handler | Extra server CPU per request, work handler |
|---|---|---|
| No middleware | 0 (baseline: 106 µs) | 0 (baseline: 506 µs) |
| Request ID and Server-Timing only | +33 µs (+31%) | +49 µs (+10%) |
| Everything on, default stdout sink | +78 µs (+74%) | +81 µs (+16%) |
| pino-http with a request ID, for comparison | +53 µs (+50%) | +115 µs (+23%) |

- **The absolute cost is what carries over.** With everything on, the middleware added about 80 µs per request with both handlers. How large that is relative to a request depends on how much your handler already costs.
- **pino-http is not a like-for-like comparison.** It adds no `Server-Timing` and no route templates. With the tiny handler it cost less than this package; with the work handler, more. The work-handler runs were noisy: the baseline's throughput ranged from 1,294 to 2,299 requests per second. So the ordering between the two is not settled by these runs.
- **Latency on a saturated machine.** p99 rose more than CPU, because client and server shared one machine at full load. Treat those percentiles as a stress signal, not as what users would see.

Raw results, ranges and caveats are in [the tiny-handler run](../../bench/results/2026-10-15-072654/summary.md) and [the work-handler run](../../bench/results/2026-10-15-075512/summary.md). Method is in [bench/](../../bench/README.md); run `npm run bench` (add `--handler=work`) to measure on your own machine. Numbers from one machine and one session describe that machine only.

## Not in scope

OpenTelemetry integration, distributed tracing, metrics endpoints, dashboards, automatic database instrumentation, sampling and profiling. Some may come later as separate, optional pieces.

## License

MIT
