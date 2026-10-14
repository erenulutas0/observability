# Architecture — express-observe

Status legend: **[implemented]** exists in code and is covered by tests · **[proposed]** agreed design, not yet in code · **[idea]** not scheduled.

As of Phase 5 (2026-10-14): the middleware, the diagnostic-lab demo (v0.1 scenarios), the README and the benchmark harness are **[implemented]**. Measured cost and CPU profiles: `bench/results/2026-10-14-073334/`.

## 1. What the package does

`observe(options)` returns one Express middleware (Express 4 and 5). For every request it:

1. Assigns a request ID (`req.id`, `X-Request-Id` response header).
2. Starts a monotonic clock and exposes `res.serverTiming` for custom timers.
3. Writes a `Server-Timing` header right before response headers are flushed.
4. Emits exactly one structured access-log record when the response terminates (finished or interrupted).

It is a building block, not a platform: no agent, no exporter, no dashboard. Output is a plain object handed to a sink (default: one JSON line on stdout).

## 2. Module layout

```
packages/express-observe/src/
├── index.js           [implemented] observe(options): validates options, wires the modules, returns middleware
├── request-id.js      [implemented] isValidRequestId(), generateRequestId(), resolveRequestId(req, policy) -> { id, source }
├── server-timing.js   [implemented] per-response timer registry + header serialization (W3C Server-Timing)
├── logger.js          [implemented] record builder, opt-in extension, default stdout sink, sink error isolation, rate-limited warnings
└── route-template.js  [implemented] route capture at match time, mount template matching, explicit labels
```

Each module is pure where possible (input -> output) so unit tests do not need an HTTP server. `index.js` is the only module that touches the Express lifecycle.

## 3. Request lifecycle (Node 22 `http`, Express 4.22)

```
client -> socket -> http.Server parses head -> express app
                                                 |
                                                 v
                                     observe() middleware runs      t0 = hrtime (monotonic)
                                                 |  req.id set, X-Request-Id set
                                                 |  res.serverTiming created
                                                 |  onHeaders(res, ...) registered
                                                 |  'finish' + 'close' listeners registered
                                                 v
                                     routing -> handlers -> res.send / res.write / next(err)
                                                 |
               +---------------------------------+------------------------------+
               v                                 v                              v
  res.writeHead (implicit or explicit)   handler throws / next(err)      client closes socket
  - on-headers callback fires            - Express finalhandler           - no 'finish'
  - Server-Timing written here           - 500 sent -> writeHead          - 'close' only
  - res.headersSent = true                 -> finish
               |
               v
        'finish' (body fully handed to the OS)
               |
               v
        'close' (always follows 'finish' on Node >= 12; NOT an abort signal by itself)
```

Facts the design relies on (Node 22 / Express 4 behaviour):

- `res.headersSent` flips to `true` inside `writeHead`. Every Express response helper (`send`, `json`, `end`, `write`, `sendFile`, `redirect`) ends up in `writeHead`, either explicitly or via `_implicitHeader`. That is the last safe moment to add headers.
- `finish` means the last chunk was handed to the kernel. It does **not** mean the client received it.
- `close` fires on every response in modern Node, including successful keep-alive responses. Interruption is detected as **the response ended without a `finish` event**, never as "close happened". `res.writableFinished` is not used for this: once the socket is gone it can read `true` for a response that was ended after the client had already disconnected.
- `req.aborted` and the `aborted` event are deprecated (Node DEP0156) and are not used.
- Express 4 wraps synchronous handler execution in `try/catch` and forwards to `next(err)`. **Rejected promises from `async` handlers are not caught** by Express 4; the request hangs until the client gives up, and the process may see an `unhandledRejection`. Express 5 fixes this. We document it; we cannot fix it from inside a middleware without wrapping user handlers.

## 4. Component design

### 4.1 Request ID (`request-id.js`) **[implemented]**

| Concern | Decision |
|---|---|
| Generation | `crypto.randomUUID()` (Node built-in, CSPRNG-backed) |
| Exposure | `req.id`; response header `X-Request-Id` (name configurable) |
| Incoming header policy | `trustIncoming: false \| true \| (req) => boolean`. Default **false** (see ADR-0001, decision 3) |
| Validation of incoming IDs | length 1–128, charset `^[A-Za-z0-9._-]+$`. Rejected IDs are ignored and a fresh ID is generated. Never throws, never 4xx |
| Existing `req.id` | If `req.id` is already a valid string when we run (another middleware set it), keep it and record `requestIdSource: "existing"`. Option `onExistingId: "keep" \| "replace"`, default `keep` |
| Existing `req.id` that is not a valid ID | Replaced (e.g. a number set by another library), so `req.id` and the header always agree. Precedence under `keep`: existing valid `req.id` > trusted incoming header > generated |
| Duplicate incoming headers | Node joins repeated `X-Request-Id` lines with `", "`; the comma fails validation, so a fresh ID is generated. There is no safe way to pick one of several client IDs |
| `trustIncoming` callback throws | Treated as "not trusted"; one rate-limited stderr warning naming only the error class, never its message |
| Mounted twice | The second `observe()` on the same request is a no-op (per-response symbol marker) |
| Trust semantics | An accepted client ID is **correlation data, not identity**. It is never assumed unique. The log record carries `requestIdSource: "generated" \| "client" \| "existing"` so consumers can tell them apart |

The charset restriction also prevents header injection (`\r\n`) and log-line injection.

### 4.2 Server-Timing (`server-timing.js`) **[implemented]**

Header format per W3C Server-Timing: `Server-Timing: db;dur=12.3, cache;dur=0.4;desc="hit", app;dur=48.2`.

| Concern | Decision |
|---|---|
| Clock | `process.hrtime.bigint()` (monotonic, ns); durations serialized with 1 decimal in the header, 3 decimals in the log |
| Built-in metric | `app;dur=` = time from middleware entry to **header flush** ("time to headers"). This is deliberately **not** the total request duration, which is only known at `finish` and goes to the log as `durationMs` |
| API | `res.serverTiming.start(name)`, `.end(name)`, `.add(name, durationMs, desc?)`; all return `undefined` and never throw |
| Finalization | Inside the `on-headers` callback: serialize finished timers plus `app`, call `res.setHeader('Server-Timing', ...)`, appending to an existing value if the app set one |
| Duplicate `start(name)` | Restarts the timer (last start wins) |
| Same name measured twice | A later `end()` or `add()` replaces the earlier duration (latest wins). The entry keeps the position of its first use |
| Reserved name | `app` is reserved for the built-in metric; user calls with it are ignored |
| `end()` without `start()` | Ignored |
| Unfinished timer at header flush | Omitted from the header. Not auto-closed, because a partial duration would be misleading |
| `start/end` after headers sent | Accepted silently (no header mutation, no throw). Possible future: expose late timers in the log record **[idea]** |
| Limits | `maxEntries` default 16; name must match `^[A-Za-z0-9_-]{1,32}$` (a safe subset of an HTTP token); `desc` max 64 chars, quoted and sanitized. Over-limit entries are dropped. Details: `maxEntries` allowed 1–64 and counts distinct custom names (`app` excluded); `desc` keeps printable ASCII only, then `"` and `\` are escaped; invalid durations (`NaN`, negative, infinite, non-number) are dropped |
| Existing header | Merged: a string value becomes `existing, ours`; an array value gets an extra field line. Works for `setHeader` and for headers passed to `writeHead(status, headers)` |
| Disabled (`serverTiming.enabled: false`) | No header; `res.serverTiming` is a frozen no-op object, so application code does not need feature checks |
| Internal failure while writing the header | Caught inside the `writeHead` hook (it would otherwise surface in the app's `res.send()`), reported via the rate-limited warning |
| Cross-origin browsers | `Timing-Allow-Origin` is **not** set by default; option `timingAllowOrigin` **[idea]** for browser clients. Not needed for native mobile clients |
| Streaming / early flush | Works because the hook is on `writeHead`, which runs on the first `res.write()` too. Timers ended after the flush simply do not appear |

### 4.3 Route template (`route-template.js`) **[implemented]**

Express 4 exposes two relevant values:

- `req.route.path`: the matched **leaf** route pattern as written by the developer (`"/users/:id"`). Assigned in `Route#dispatch`, so it only exists after routing. It can also be a RegExp or an array, which we treat as unknown.
- `req.baseUrl`: the **concrete** mount prefix (`"/users/42/posts"` for `app.use('/users/:userId/posts', router)`). It is a real URL fragment and may contain IDs. **It is never logged.**

Capture at match time: Express restores `req.baseUrl` when control leaves a router through `next()` / `next(err)`, while `req.route` stays set. Reading both at termination would pair a nested leaf pattern with the wrong prefix on error paths (for example `/items/:itemId` instead of `/api/items/:itemId`). The middleware therefore installs a per-request accessor on `req.route` that records `{ path, baseUrl }` at the moment Express assigns it. Reads of `req.route` return the same value as before; no Express prototype, `Router` or `Layer` is patched. If the property cannot be redefined, the code falls back to reading both values at termination. See ADR-0003.

Resolution order (evaluated when the response terminates):

1. `res.locals.observeRoute`, if it is a printable-ASCII string of 1–256 characters.
2. `options.route.resolver(req, res)`, if it returns such a string. Any other return value falls through; a throw falls through and produces one rate-limited warning.
3. Captured `route.path` (string starting with `/`) with an empty `baseUrl` gives `route.path`.
4. Captured `route.path` with a non-empty `baseUrl`: `baseUrl` is matched against `options.route.mounts`. Mount templates support literal and `:param` segments only (wildcards, optional or regex params are rejected at startup). Segment counts must be equal and literals compare case-insensitively, as Express 4 routing does by default. On a match the label is `template + route.path`, without a trailing slash for a router's `/` route. No match gives **`null`**.
5. Anything else gives `null`.

Consequences, all covered by tests:

- An unmatched URL gets `null`. A 404 sent by a matched handler keeps its label.
- A route that calls `next()` and ends in Express's 404 keeps the label of the last matched route.
- A response produced by plain middleware (`app.use(...)`, no route) gets `null` unless labelled explicitly.
- A static mount such as `app.use('/api', router)` also needs `mounts: ['/api']`; without it the label is `null`. This is the price of never logging `baseUrl`.
- Nested mounts need the full prefix template, for example `'/orgs/:orgId/teams/:teamId'`.

### 4.4 Structured logging (`logger.js`) **[implemented]**

One record per request, built when the response emits `finish`, or `close` without a prior `finish`:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-10-13T20:14:03.117Z",
  "requestId": "0b1c0f8e-2b7a-4d1e-9c3a-7f6e5d4c3b2a",
  "requestIdSource": "generated",
  "service": "orders-api",
  "release": "1.4.2",
  "method": "GET",
  "route": "/users/:id",
  "status": 200,
  "headerDurationMs": 12.418,
  "durationMs": 48.213,
  "termination": "finished"
}
```

Field rules:

- `timestamp` is the wall-clock time at termination (ISO 8601, UTC). Durations come from the monotonic clock and are rounded to 3 decimals.
- `status` is `res.statusCode` **only if `res.headersSent`**; otherwise `null`. Node defaults `statusCode` to 200 before anything is sent, and an interrupted request must not look like a success.
- `termination` is `"finished"` when the response emitted `finish` (the last chunk was handed to the OS), otherwise `"interrupted"`. Nothing else is inferred from `close`. An interruption is an HTTP fact, not evidence that the user cancelled on purpose.
- A client that disconnects before `observe()` even runs (for example during a slow earlier middleware) is still logged once, as `interrupted`. `status` and `route` may then reflect a response the handler wrote to a closed connection.
- `headerDurationMs` = middleware entry -> header flush (the same number as the `app` Server-Timing entry). `null` if headers were never sent. It separates a *late-headers* request from a *slow-body* request with the same total time. See section 9.
- `durationMs` = middleware entry -> termination. Time Node spends parsing the request head before Express runs is not included.
- `service` and `release` come from options; default `null`. No env-var fallback in v0.1.
- `route` per section 4.3; `null` when unknown.
- The record is built from an explicit field list. Nothing is copied from `req` or `res` wholesale.

Never logged by the middleware: request/response bodies, raw URL and query string, request/response headers, cookies, IP addresses, user identifiers, error messages and stack traces. A sentinel-based test plants each of these in a request and checks stdout and stderr.

Opt-in extension (ADR-0001 decision 5): `log.extend(req, res) => object` is shallow-merged into the record. **Core fields always win**, so an extension cannot forge `status`, `route` or `requestId`. A throwing extension or a non-object return value is ignored and the core record is still emitted. The application is responsible for whatever it adds.

Sink contract:

- `sink(record)` receives the **object**, never a string. The default sink does `process.stdout.write(JSON.stringify(record) + "\n")`, so `sink: (r) => pino.info(r)` works without double encoding.
- A synchronous throw is caught. A returned thenable gets a rejection handler. Both go to `onSinkError(err, record)`. Without `onSinkError`, one stderr line naming the error class is written, **rate-limited** to one per 10 s per middleware instance. An `onSinkError` that throws is contained the same way.
- A value the default sink cannot serialize (for example a `BigInt` added by `extend`) is reported as a sink failure, not thrown.
- No buffering, no retry, no flush on exit. Backpressure on stdout is left to Node; we do not wait for `drain`. Delivery after process exit or during sink failure is **not** promised.
- The sink runs after the response has terminated, so a slow async sink does not delay the response. A sink that blocks the event loop synchronously will still slow down the whole process; that cannot be prevented from inside a middleware.

### 4.5 Error and connection handling (`index.js`) **[implemented]**

- Single-shot: one `finish` and one `close` listener per response; whichever fires first decides the record (ADR-0007). On Node >= 12 every `ServerResponse` emits `close`, also on disconnect and socket error. A response that is already destroyed when `observe()` runs is reported on the next turn of the event loop. A per-response `logged` flag is kept as belt-and-braces.
- Application errors: `next(err)` reaches the application's error middleware or Express's `finalhandler` unchanged. The middleware never touches the error object. Logged as `status: 500` (or whatever the handler sent), `termination: "finished"`.
- `next(err)` after headers were sent: Express destroys the socket. Logged as `termination: "interrupted"` with the status that was actually sent.
- Client disconnect before headers: logged as `interrupted`, `status: null`, `headerDurationMs: null`. If the handler responds later, no second record appears.
- A handler that never responds (for example an unhandled rejection in an Express 4 `async` handler) produces no record until the connection closes; then it is logged as `interrupted`.
- The middleware's own failures (route resolver, extension, sink, record building) are caught and reported through the rate-limited warning or `onSinkError`. They never call `next(err)` and never throw into the request pipeline.
- Headers after `headersSent`: header writes happen either at middleware entry behind a `headersSent` check or inside the `on-headers` hook, which runs before the flush.
- Outside our control: Express 4's default error handler prints the error stack to stderr when `NODE_ENV` is not `test`. Applications that must keep stacks out of stderr need their own error middleware.

## 5. Dependencies **[implemented: on-headers 1.1.0 only; ADR-0001, ADR-0007]**

Runtime:

| Package | Version | Why | Alternative rejected |
|---|---|---|---|
| `on-headers` | ^1.1.0 | Correctly intercepts every `writeHead` form (status-only, status+headers object, legacy array form). 1.1.0 contains the fix for CVE-2025-7339. Zero dependencies, maintained by jshttp (the Express org) | Hand-written `writeHead` patch: same technique, less battle-testing, and we would own the CVE surface |
| ~~`on-finished`~~ | removed | Replaced by `finish` + `close` listeners after it measured as the largest middleware-attributable cost (8.6 µs per request in the micro benchmark) and after a termination bug showed a `finish` listener was needed anyway (ADR-0007) | |

Peer: `express ^4.17 || ^5` (tested against 4.22.3 and 5.3.0). Dev: `jest ^30`, `supertest ^7`, `express 4.22.x`, `express5` (alias for `express@5.3.0`). Bench only: `autocannon ^8`, `pino-http ^11`.

## 6. Options surface (v0.1) **[implemented]**

Validation limits: `service`/`release` are non-empty strings up to 256 characters or `null`. `requestId.header` must be an RFC 9110 token. `serverTiming.maxEntries` is an integer from 1 to 64. `route.mounts` holds at most 256 templates of literal and `:param` segments. `route.resolver`, `log.sink`, `log.onSinkError` and `log.extend` must be functions or `null`.

```js
observe({
  service: 'orders-api',          // string | null
  release: '1.4.2',               // string | null
  requestId: {
    header: 'X-Request-Id',       // incoming + outgoing header name
    trustIncoming: false,         // boolean | (req) => boolean
    onExistingId: 'keep',         // 'keep' | 'replace'
  },
  serverTiming: {
    enabled: true,
    maxEntries: 16,
  },
  route: {
    mounts: [],                   // mount templates for nested routers, e.g. ['/users/:userId/posts']
    resolver: null,               // (req, res) => string | null
  },
  log: {
    enabled: true,
    sink: null,                   // (record) => void | Promise<void>; default stdout JSON line
    onSinkError: null,            // (err, record) => void; default rate-limited stderr warning
    extend: null,                 // (req, res) => object; opt-in extra fields
  },
})
```

Unknown options throw at construction time (fail fast at startup, never per request).

## 11. `express-observe analyze` (CLI) **[implemented, ADR-0004]**

```
packages/express-observe/
├── bin/express-observe.js   argument parsing (node:util parseArgs), subcommand dispatch, exit codes
├── src/analyze.js           record validation, grouping, nearest-rank percentiles, honesty notes
└── src/analyze-format.js    plain-text table; every log-derived string reduced to printable ASCII
```

- Input: files or stdin, JSON lines, LF or CRLF. A record must have `schemaVersion: 1` and valid core fields; extra top-level fields from wrapping loggers are ignored. Skipped lines are counted per reason.
- Per group: count, finished, interrupted, status classes, 5xx rate, `durationMs` p50/p95/p99/max and `headerDurationMs` p50/p95/p99, computed from finished records only. p95 needs 20 values and p99 needs 100; otherwise `null`.
- Memory: two `Float64Array` values per finished request; no bounded mode yet.
- Report JSON carries `reportVersion: 1`. Exit codes 0 / 1 / 2 as in the ADR.

## 12. `express-observe doctor` (CLI) **[implemented, ADR-0005]**

`src/doctor.js` probes a running server from the outside; it never loads application code.

- Validation before any connection: http(s) origin only, no credentials in the URL, loopback hosts unless `--allow-remote`, at most 10 paths starting with a single `/`.
- Probes: 2 GETs per path, one GET with a random client request ID, one GET to a random unmatched path. Sequential; hard deadline per request (`--timeout`); bodies read up to 64 KiB; no redirects followed; `User-Agent: express-observe-doctor/<version>`; random markers in a query parameter and a header.
- Header checks: request ID present, valid and unique; client-ID policy (info); Server-Timing well-formed with an `app` entry; unmatched path observed.
- With `--log`: the file is streamed read-only, only lines mentioning a probe's request ID are parsed, using the same record validation as `analyze`. Checks: one record per probe, route labels (null on a successful probe, raw path on the unmatched probe, a route equal to a concrete ID-like path), markers anywhere in the file.
- Output: text or `--json` (`reportVersion: 1`); every log- or response-derived string printed as printable ASCII. Exit codes 0 / 1 / 2.

## 13. React Native correlation demo **[implemented on branch feat/react-native-demo, ADR-0006]**

```
examples/react-native-correlation/
├── correlation.js   platform-neutral traced client: one request ID per attempt, Server-Timing parsing, timeouts, retries
├── join.js          joins client attempts with access-log records by sent ID, then by response ID; honest readings
├── join-cli.js      node join-cli.js <client-log> <access-log>
├── server.js        example API (loopback, trustIncoming: true, /api mount, allowlisted delays and sizes)
├── node-client.js   same session in Node, for development and tests (not mobile evidence)
├── test/            Jest, real HTTP against server.js
└── app/             Expo SDK 57 app, outside the npm workspace, imports ../correlation.js via Metro watchFolders
```

The client never uploads its attempts; they are printed to the console and joined offline.

## 7. Express 5 **[implemented, ADR-0008]**

The full package test suite runs against Express 5.3.0 as well as 4.22.3 (`npm test` runs both; `jest.express5.config.js` maps `express` to an `express5` npm alias). The only difference that needed version-specific tests was route syntax; behaviour that differs by design is tested per version: Express 5 turns a rejected `async` handler into a finished 500 record, Express 4 leaves it open until the client gives up. The notes below were the plan before support was verified.


`req.route`, `req.baseUrl`, `writeHead`, `finish`/`close` all survive in Express 5. Differences to handle later: path-to-regexp v8 syntax (`/*splat`, no bare `*`), and async handler rejections being routed to `next(err)` automatically (which makes the error story simpler, not harder).

## 8. Out of scope for v0.1

OpenTelemetry integration, distributed tracing / trace-context propagation, Prometheus or any metrics endpoint, dashboards, automatic DB/Redis instrumentation, profiling, root-cause analysis, mobile SDK, cloud deployment. Candidate follow-ups (not scheduled): `analyze` CLI over JSON logs, `doctor` integration checker, React Native correlation demo.

## 9. Measurement vocabulary and interpretation limits **[server-side fields implemented; client names reserved, ADR-0002]**

The package measures the server side only. The names below are used consistently in code, logs, README and the demo so that nobody mistakes one for another.

| Name | Where | Start -> end | What it is **not** |
|---|---|---|---|
| `headerDurationMs` / `app;dur` | log record / `Server-Timing` | middleware entry -> `writeHead` | total request time |
| `durationMs` | log record | middleware entry -> `finish` or early `close` | time the client waited; `finish` only means the kernel accepted the last chunk |
| custom `name;dur` | `Server-Timing` | `serverTiming.start(name)` -> `end(name)` | a share of the total; parallel operations can legitimately sum to more than `durationMs` |
| `termination` | log record | HTTP outcome at the server | user intent |
| `clientAttemptMs` | **client only** (future demo) | one physical HTTP attempt as seen by the client | network time; `clientAttemptMs - durationMs` is not "the network" |
| `operationMs` | **client only** (future demo) | user action -> usable UI result | a server metric; one operation may spawn several attempts, each with its own request ID |

Rules that follow from this:

- A request still in flight has produced **no record**. "No log line" never means "no request".
- `Server-Timing` values are durations measured on the server clock. They do not imply synchronized clocks with the client and are not timestamps.
- The middleware does not compute `dbMs`, payload sizes or any derived "network" number. Those belong to the demo or to the application's own instrumentation, where they can be labelled honestly.
- When the data needed for a conclusion is missing, the correct output (in docs, the demo and any future `analyze` CLI) is **"unknown"**, not a guess.

## 10. Demo shape: `diagnostic-lab` **[implemented for L0, L1, L2, L7, L8 · second wave proposed, ADR-0002]**

Code: `demo/app.js` (server), `demo/lab.js` (client runner, `--check` asserts every record). Usage and the per-scenario reading guide: `demo/README.md`. The lab's reading function receives only the record, never the scenario ID.

`demo/app.js` is not a toy CRUD app. It deliberately reproduces the *same symptom* ("this request took long") through *different mechanisms*, so the logs show how `headerDurationMs`, `durationMs` and `termination` separate them.

| ID | Scenario | Expected record | What the tool must not claim |
|---|---|---|---|
| L0 | small JSON, normal | `finished`, short header and total | "no overhead" without a benchmark |
| L1 | bounded async wait **before** headers | long `headerDurationMs`, long `durationMs` | "DB is slow": there is no DB |
| L2 | headers immediately, body streamed in bounded chunks | short `headerDurationMs`, long `durationMs` | that the header metric is the total |
| L7 | client closes socket before / after headers | one record, `interrupted`, `status` null or real | that every close is a user cancel |
| L8 | custom sink that throws / rejects / is slow | HTTP behaviour unchanged, one warning | that swallowing errors has zero cost |

Second wave (after v0.1): L3 bounded CPU work, L4 prebuilt large synthetic JSON, L5 fast API + slow client, L6 one logical operation with several physical attempts. A tiny client (Node script first; React Native only if real client time is available) is added only after the server core is complete.

Safety constraints for the demo: every delay, payload size and repeat count comes from a server-side allowlist; no endpoint accepts arbitrary `delay`/`size`/`cpu` parameters; it binds to loopback by default; only synthetic data.
