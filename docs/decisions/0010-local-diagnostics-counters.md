# ADR-0010 — Local diagnostics counters: `getDiagnostics()`

- Date: 2026-10-15
- Status: **Accepted** (owner approved the shape in chat on 2026-10-15; additive public API, no change to records or headers)

## Context

The access log can only describe requests that produced a record. An external review of the project summary (item P1) asked for a small, local view of the library's own health, so that an operator can tell:

- how many requests are still open, which the final log cannot show yet;
- whether records were lost before reaching the sink;
- whether the sink is failing or has calls that never settle.

The review set the acceptance criteria:

- start and termination counts agree in a controlled experiment;
- a failing sink leaves the application's response intact and the failure is visible;
- there is no unbounded buffer;
- no global signal handler is installed silently.

It also asked that a process's numbers never be presented as a cluster total.

## Decision

1. **API.** `observe.getDiagnostics()`, also exported as a named export, returns a fresh plain object on each call:

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

2. **Scope.** The counters are kept per process, or per worker thread, because each worker loads its own copy of the package. They add up every `observe()` instance in that process or thread. `pid`, `threadId` and `since` are in the snapshot so that a number copied elsewhere still says where it came from. `since` is when the package was loaded.

   Some numbers are never included:
   - Other cluster workers or other processes.
   - A second copy of the package installed elsewhere in `node_modules`.
   - Requests that never reached `observe()`.
   - Anything from before a restart.

3. **Definitions.**

   | Counter | Counts |
   |---|---|
   | `started` | Requests on which an instance began observing. A second instance on the same request is a no-op and is not counted. |
   | `finished`, `interrupted` | Terminations, decided by the same rule as the record's `termination` field (ADR-0007). |
   | `inFlight` | `started − finished − interrupted` at the moment of the snapshot. |
   | `emitted` | Records handed to a sink, meaning the sink function was called. This is not delivery. |
   | `dropped` | Terminations, with logging enabled, whose record could not be built, so the sink was never called. |
   | `sinkErrors` | Sink calls that threw or returned a promise that rejected. |
   | `sinkPending` | Promises returned by sinks that have not settled yet. |
   | `warnings` | Internal warnings raised, including those whose stderr line the rate limit suppressed. |

   Termination is now tracked even when `log.enabled` is false, so the request counters work in every configuration. The record counters move only for instances with logging enabled.

   When every instance logs, this holds once all requests have terminated:

   ```
   finished + interrupted = emitted + dropped
   ```

4. **Counters only.** Each counter is a fixed number that only goes up, apart from `inFlight` and `sinkPending`, which go down as work completes. There is no reset; take differences between two snapshots. There are no per-route, per-status or per-user counters, no buffer of records, no timer, no HTTP endpoint, and no signal, `exit` or error handlers.

## Alternatives rejected

- **Per-instance counters** (`middleware.diagnostics()`). They match tests well, but most applications have one instance. Operators want "this process", not "this `app.use` call". A process-wide view also covers the duplicate-instance rule without double counting.
- **A reset function.** Any code could reset counters that another part of the application relies on. Counters that only increase, read as differences, avoid that.
- **Per-route counters or histograms.** They grow with the route table and duplicate what `analyze` derives from the log.
- **Exposing counters over HTTP or as Prometheus metrics.** That is out of scope (ADR-0001). An application can publish the snapshot itself.
- **Sharing counters across package copies through `globalThis`.** Different versions might disagree on the shape.

## Consequences

- The public API gains one function and one documented snapshot shape. `schemaVersion` versions that shape, separately from the record's.
- The default path does a few integer increments per request. A paired micro benchmark showed no measurable change; the median difference was −0.03 µs, within the same-code noise. With logging disabled, each request now gets `finish` and `close` listeners, as it already did with logging enabled. That configuration measured about +2 µs per request, slower in 11 of 12 rounds, but a same-code run drifted +1.75 µs, so it is not resolvable here. Results are in `bench/results/micro-2026-10-15/`.
- A process crash loses the counters, and numbers from a process that was killed cannot be recovered. They are a local signal, not an audit trail.
