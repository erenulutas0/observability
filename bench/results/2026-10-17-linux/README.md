# Linux measurements — 2026-10-17

- **Environment:** Docker Desktop's Linux VM (WSL2, kernel 6.6.87.2) on the same Windows 11 desktop as the other 2026-10 results.
- **Hardware:** Intel i5-12500, 12 logical CPUs visible to the VM.
- **Software:** Node 22.23.2 in `node:22.23.2-bookworm-slim`, Express 4.22.3.
- **Code:** branch `feat/trial-followups` at d32b3a7, copied into the container with `git archive`, so the manifests have no commit hash.

Same hardware means Windows and Linux can be compared, but it is a VM sharing the host. The ranges below are wide, and the host was not idle.

## Tests

`npm test` passed in the container on both passes: Express 4, Express 5 and the React Native example. The first pass ran 257 package tests; the second ran 264, which include the new idle-stop tests. `npm run lab:check` passed on both. CI also runs on Linux; this confirms the same result on this VM.

## Event-loop sampler (files `sampler-pass1.txt`, `sampler-pass2.txt`)

| Measurement | Result |
|---|---|
| Idle, sampler on, 20 ms, no idle stop (pass 1) | 0.85–0.88% of one core |
| Idle, a bare 20 ms `setInterval`, no express-observe (pass 1) | 0.79–0.93% |
| Idle, sampler on, 100 ms (pass 1) | 0.25% |
| Idle after 12 s of silence, `idleStopMs: 0` (pass 2) | 0.69–0.72% |
| Idle after 12 s of silence, `idleStopMs: 10000`, the new default (pass 2) | 0.00% |
| 100 req/s, sampler on vs off, three rounds each, pass 1 | No difference: on was lower in two of three rounds |
| 100 req/s, sampler on vs off, three rounds each, pass 2 | On was higher in all three rounds, by 0.5–3.2 points of one core |

- **Idle:** the idle cost is the cost of waking every 20 ms, the same as a bare timer and about the same as on Windows. The new idle stop removes it.
- **Under load:** the two passes disagree. The cost is somewhere between nothing and about 3% of one core at 100 req/s, and these measurements cannot settle it.

## Benchmark (`tiny/`, `work/`: medians of five 30 s runs, ranges in each `summary.md`)

| Configuration | Extra server CPU per request, tiny handler | Extra server CPU per request, work handler |
|---|---|---|
| No middleware | 0 (baseline 131 µs) | 0 (baseline 642 µs) |
| Request ID and Server-Timing only | +28 µs | +88 µs |
| Everything on, default stdout sink | +103 µs | +82 µs |
| pino-http, for comparison | +49 µs | −52 µs |

- **Tiny handler:** the absolute cost is close to Windows: +103 µs against +78 µs with everything on.
- **Work handler:** the runs are too noisy to use. pino-http came out cheaper than no middleware, which is not possible, and the full-log range was 529–1,168 µs.
- **Correctness:** every run passed the correctness checks: no errors, the expected headers, and log lines equal to the requests handled.
