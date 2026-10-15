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

Same, plus assertions on every record. At the end it compares the package's `getDiagnostics()` counters with the records and sink failures the lab received itself. Exits with code 1 if any scenario misbehaves or the counters disagree.

```bash
node demo/lab.js --log=lab.jsonl
```

Also writes every delivered record to `lab.jsonl`, which you can then summarize:

```bash
npx express-observe analyze --slowest 3 lab.jsonl
```

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

## Second wave: what the server cannot see

These scenarios need several requests or work on the client, so the lab prints two kinds of lines for each: `reading`, what the record alone supports, and `actually`, what the scenario did. The gap between them is the lesson.

| ID | What happens | What the records show | What actually happened |
|---|---|---|---|
| L3 | `GET /lab/l3/long` burns 80 ms of CPU; three `GET /lab/l0` are sent from another thread while it runs | The CPU request: about 80 ms before headers, with `cpu;dur=80` in Server-Timing. The three fast requests: `durationMs` about 0.3 ms each, but `eventLoopDelayMs` about 70–78 ms (the demo enables `eventLoop`) | The fast clients waited about 70 ms for the blocked event loop **before `observe()` ran**. `durationMs` cannot contain that wait; `eventLoopDelayMs` shows the process was blocked, not which code blocked it |
| L4 | The same 50,000-item document (about 4 MB) is sent prebuilt, then serialized with `res.json()` | Serialized: more `headerDurationMs` (for example 17 ms against 4 ms) | `JSON.stringify` runs before headers can be written. The record cannot name it, and the client's parsing is in neither record |
| L5 | A fast request, then 120 ms of client-side work before the result is usable | A fast, correct record (under 1 ms) | The user waited for the client's own work |
| L6 | `GET /lab/l6/flaky` answers 503, the client retries and gets 200 | Two complete, unremarkable records with two request IDs | One user action took both. Only a client-side operation ID ties them together, as in [the React Native example](../examples/react-native-correlation/README.md) |

The lab sends L3's fast requests from a worker thread, because the lab's client and server share a process: a client on the main thread would be frozen by the same blocked event loop it is trying to observe.
