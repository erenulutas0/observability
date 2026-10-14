# ADR-0007 — Replace on-finished with finish/close listeners

- Date: 2026-10-14
- Status: **Accepted** (measured; revises ADR-0001 decision 1 for on-finished only; on-headers stays)

## Context

ADR-0001 chose `on-finished` 2.4.1 to get one callback per response across `finish`, socket `close` and socket `error`, with the alternative of a small listener on Node >= 12 kept open. Two things changed:

1. **A correctness bug.** Termination was classified with `res.writableFinished`. When the client disconnected during an earlier middleware, the record was built after the handler had written to the dead response; with the socket already detached, `writableFinished` read `true` and the request was logged as `finished`. Fixed in commit c1c10f7 by recording whether the response emitted `finish`, which already needed a `finish` listener of our own.
2. **Measured cost.** A CPU profile of the in-process micro benchmark put `on-finished` and its `ee-first` helper at about 6.6% of self time in the full-log configuration, the largest single block attributable to the middleware.

## Decision

`index.js` attaches two listeners per response: `finish` reports `finished`, `close` without a prior `finish` reports `interrupted`. On Node >= 12 every `ServerResponse` emits `close`, also on client disconnect and socket error. If the response is already destroyed when `observe()` runs, `close` has been emitted already, so the callback is scheduled with `setImmediate` as `interrupted`, matching what `on-finished` did for already-finished messages. `on-finished` is removed from the runtime dependencies; `on-headers` remains the only one.

## Evidence

- Correctness: all 200 package tests pass, including the real-socket disconnect tests and the new disconnect-before-observe test. Four deliberate breakages of the new code (no already-destroyed check, no close listener, close reported as finished, already-destroyed reported as finished) were each caught.
- Micro benchmark (`bench/micro.js`, single-threaded GC, 12 rounds x 40,000 requests, full-log): B lower in **12 of 12** rounds, median paired difference **−8.6 µs per request (−8.6%)**. The same setup comparing the old code with itself: 7 of 12 rounds, −1.4%.
- HTTP benchmark (`bench/ab.js`, 6 rounds, full-log, `bench/results/ab-2026-10-14-135053/`): B lower in **6 of 6** rounds, median paired difference **−38 µs of server CPU per request (−16%)**, throughput 4,653 → 5,523 req/s, all correctness checks passed (log lines equal to requests handled). The HTTP noise floor on this machine is about 5% (`ab-2026-10-14-132335`), so the direction is clear.
- The HTTP gain is much larger than the micro gain. A likely reason, not verified: `on-finished` adds and later removes `error`/`close` listeners on the socket for every request, and on a long-lived keep-alive socket that churn costs more than on the micro benchmark's fresh in-memory socket per request. Treat −8.6 µs as the conservative figure.

## Consequences

- One runtime dependency (`on-headers`) instead of two. `on-finished` remains in the tree only as a dependency of Express itself.
- The pipelining edge case is unchanged: a pipelined response that never received a socket is not reported by either implementation.
- If a future Node version stops emitting `close` on `ServerResponse`, records for interrupted requests would be lost; the real-socket tests would catch it.
