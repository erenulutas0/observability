# Performance candidates — 2026-10-14

Each candidate was measured against the commit before it with `bench/micro.js` (in-process, single-threaded GC, CPU µs per request, A and B alternating, 12 rounds unless noted) and, where relevant, `bench/ab.js` (real HTTP, server CPU per request, 6 rounds). Rule from AGENTS.md: keep a change only if B wins in every round and the difference clearly exceeds an A-vs-A run.

Machine: Windows 11, i5-12500, Node 22.23.2, Express 4.22.3. A VirtualBox VM and the Android emulator were running, which is why noise floors matter here.

| Candidate | Evidence | Decision |
|---|---|---|
| Noise floor, HTTP (`main` vs itself) | ids-timing: identical code differed by a median 4.5%, same direction in 6 of 6 rounds | HTTP results under about 5% are not resolvable here |
| Noise floor, micro (fixed commit vs itself) | full-log: 7 of 12 rounds, −1.4%; ids-timing: 7 of 12, −1.1% | |
| **Replace `on-finished` with `finish`/`close` listeners** | micro full-log: **12 of 12**, −8.6 µs (−8.6%). HTTP full-log: **6 of 6**, −38 µs server CPU (−16%), 4,653 → 5,523 req/s, correctness checks passed | **Kept** (ADR-0007, commit 249bec8) |
| Fewer allocations in `server-timing.js` (lazy Map, no guard wrappers) | micro ids-timing: 9 of 12, −2.6%; full-log: 7 of 12, −3.5% | Not kept: inconclusive at this noise level |
| Cost of the per-request `req.route` accessor (ADR-0003), measured by removing it | micro full-log: 11 of 12, −11 µs (−12%) | Measurement only: the accessor fixes mislabelled routes on error paths, so it stays |
| `req.route` accessor once on `app.request` instead of per request | micro full-log: 8 of 12, −4.3% (B won rounds 1–6, lost most of 7–11, so load changed mid-run). HTTP: 4 of 6, −2.5% | Not kept: inconclusive, and it touches Express's request prototype |

Files: `candidate3-close-listener.txt`, `candidate1-server-timing-allocations.txt`, `route-accessor-removed-cost.txt`, `route-accessor-on-prototype.txt`. HTTP runs: `../ab-2026-10-14-132335` (noise floor), `../ab-2026-10-14-135053` (on-finished), `../ab-2026-10-14-140912` (prototype accessor).

Also found while profiling: the first micro harness destroyed its in-memory socket with writes still buffered, so Node built an `ERR_STREAM_DESTROYED` error per request (about 10% of samples). Fixed in the harness before any of the numbers above were taken.
