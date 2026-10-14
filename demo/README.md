# diagnostic-lab

A small Express app that produces the same symptom, "this request took long" or "this request failed", through different, deliberately bounded mechanisms. Comparing the access-log records shows which mechanisms `express-observe` can tell apart, and where the honest answer is "unknown".

No database, no external service, synthetic data only. The server binds to `127.0.0.1`. Every delay, chunk count and failure mode comes from a fixed allowlist in `app.js`; no request parameter can choose an arbitrary duration, size or CPU cost.

## Run it

From the repository root, after `npm install`:

```bash
npm run lab
```

Runs every scenario against an in-process server with a real HTTP client and prints, per scenario, what the client saw, the record, and a reading derived from the record alone.

```bash
npm run lab:check
```

Same, plus assertions on every record. Exits with code 1 if any scenario misbehaves.

```bash
npm run demo
```

Starts the server on `http://127.0.0.1:3000` (override with `PORT`). Records go to stdout as JSON lines; try the routes below with `curl -i`.

## Scenarios

| ID | Route | What happens | What the record shows | What it must not be read as |
|---|---|---|---|---|
| L0 | `GET /lab/l0` | Small JSON, immediately | `finished`, 200, short `headerDurationMs` and `durationMs` | Proof that the middleware has no overhead. Only a benchmark can say that |
| L1 | `GET /lab/l1/short`, `/lab/l1/long` | Waits 50 or 150 ms, then responds. The wait is timed as `wait` in `Server-Timing` | `headerDurationMs` almost equal to `durationMs`, both long | "The database is slow". There is no database; the record only says time passed before headers |
| L1 | `GET /lab/l1/other` | Matched route answers 404 | `route: "/lab/l1/:profile"`, 404 | A missing route. The route matched; the handler chose 404 |
| L2 | `GET /lab/l2/short`, `/lab/l2/long` | Headers at once, then 3 or 6 chunks 50 ms apart | Short `headerDurationMs`, long `durationMs` | A slow server, or a slow client. The record cannot separate slow body production from a slow reader |
| L7 | `GET /lab/l7/before-headers` | Server would answer after 500 ms; the lab client disconnects after 100 ms | `interrupted`, `status: null`, `headerDurationMs: null` | A user who cancelled on purpose. Proxies, timeouts and network failures look the same |
| L7 | `GET /lab/l7/mid-body` | First chunk at once, rest after 500 ms; the lab client disconnects after the first chunk | `interrupted`, `status: 200` | A successful response. Status 200 was sent, the body was not completed |
| L8 | `GET /lab/l8/throwing-sink` | The lab sink throws for this route | No record; `onSinkError` receives the error and the record; the client still gets 200 | "Swallowing errors is free". The record is lost and only the error callback knows |
| L8 | `GET /lab/l8/rejecting-sink` | The lab sink returns a rejected promise | Same as above, and no unhandled rejection | Same as above |
| L8 | `GET /lab/l8/slow-sink` | The lab sink waits 300 ms before writing | The client gets its response at once; the record arrives about 300 ms later | That a slow sink is harmless. A sink that blocks synchronously would still slow the whole process |
| err | `GET /lab/error` | `next(err)`; the app's own error handler answers 500 with the request ID | 500, `route: "/lab/error"`; the body carries the request ID, no message or stack | The cause. The record holds no error details by design |
| 404 | any other URL | No route matches | 404, `route: null` | Anything about the URL. It is never logged |
| nest | `GET /tenants/:tenantId/items/:itemId` | Nested router at a parameterized mount, listed in `route.mounts` | Full template, no concrete tenant or item ID | |

The lab's reading function only sees the record. It is never told which scenario produced it, which is the same constraint a future log analysis tool will have.

## Comparing client and server numbers

`lab.js` prints `clientAttemptMs`, measured by the client from request start to the end of the response. It is always larger than the server's `durationMs`, but the difference is **not** network time. The two clocks start and stop at different points: connection setup, request parsing before Express runs, kernel buffers and client-side processing all fall between them.

## Second wave (not built yet)

L3 bounded CPU work, L4 prebuilt large JSON, L5 fast API with slow client processing, L6 one user operation with several HTTP attempts. See TODO.md.
