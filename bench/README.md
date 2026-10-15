# Benchmarks

Measures what express-observe costs on top of a bare Express 4 app, and how that compares with an established HTTP logger. The goal is an honest number for one machine, not a claim of zero or negligible overhead.

## Run

From the repository root, after `npm install`:

```bash
npm run bench
```

Defaults: 4 variants, 3 rounds, 50 connections, 5 s warm-up, 15 s measured per run, about 5 minutes in total. Override with arguments:

```bash
node bench/run.js --duration=30 --warmup=10 --connections=100 --rounds=5 --variants=baseline,full-log
```

Close other heavy programs first. The script exits with code 1 if any correctness check fails.

`--handler=work` replaces the tiny handler with one that does a fixed amount of CPU work and returns about 3 KB of JSON. The work is about 0.27 ms on the reference machine. Use it to see the relative overhead against a handler that costs something; the default `tiny` handler is the worst case. It uses CPU work, not a timer, because Windows timers fire only about every 15.6 ms. A first attempt with a 2 ms `setTimeout` measured that granularity instead, and its results are kept, marked invalid.

## Variants

| Variant | Middleware |
|---|---|
| `baseline` | none |
| `ids-timing` | `observe({ log: { enabled: false } })`: request ID and Server-Timing only |
| `full-log` | `observe()`: everything on, default stdout sink |
| `pino-http` | pino-http 11 with a UUID echoed in `X-Request-Id`, `base: null`, and serializers trimmed to method and status. No Server-Timing, no route template |

Every variant serves `GET /users/42` from a `/users/:id` route. With the default handler it returns a small JSON body at once; with `--handler=work`, see above.

## Method

- **Fresh server process per run.** `server.js` runs as a child process with `NODE_ENV=production`. Its stdout, where access logs go, is redirected to a temporary file that is counted and deleted afterwards.
- **Rotated order.** Variant order shifts by one each round, so slow drift such as heat or background load does not always hit the same variant.
- **Warm-up first.** A separate autocannon run warms up the JIT before the measured window starts.
- **Percentiles from every response.** autocannon's summary has p97.5 but no p95, so p50, p95 and p99 are computed per run from the response time of every request (nearest rank). autocannon's own summary is kept in the raw files too.
- **Server-side resources.** The server reports its CPU time (user and system) during the measured window and its peak RSS.
- **Correctness per run.** No connection errors, timeouts or non-2xx responses. The expected headers are present for each variant. The number of log lines equals the number of requests the server handled, and is zero for non-logging variants.
- **Summary.** Each table cell is the median of per-run values with the min–max range. Percentiles are never averaged across runs.

## Output

`bench/results/<date>-<time>/` contains:

- `runs/r<round>-<variant>.json`: the full autocannon result, computed percentiles, server stats, log size and line count, and the environment
- `summary.md` and `summary.json`: the comparison table, correctness checks, environment and caveats
- `manifest.md`: the run manifest, following [results/MANIFEST_TEMPLATE.md](results/MANIFEST_TEMPLATE.md)

## Reading the results

- The handler does almost no work, so the middleware is a large share of each request. **The relative overhead is a worst case.** In an application whose handlers spend milliseconds on real work, the same absolute cost is a much smaller share. The CPU-per-1k-requests column is the more transferable number.
- Client and server share one machine. autocannon is single-threaded and competes with the server for CPU.
- Logs go to a file, where both the default sink and pino write synchronously. Pipes, terminals and log shippers behave differently.
- Results describe the machine and moment in `manifest.md`. Compare only runs from the same session.

## Profiling

```bash
node bench/profile.js full-log
```

Runs one variant under `--cpu-prof` and prints the functions with the most self time, overall and inside express-observe and its dependencies. Profiling slows the server down, so use it to see where cost goes, not how large it is.

## Results

- [2026-10-14 session](results/2026-10-14-073334/summary.md): first measurement of 0.1.0-dev.0 on a Windows 11 desktop, with [CPU profiles](results/2026-10-14-073334/profile.txt). A VirtualBox VM and Docker were running in the background, which shows in the wide min–max ranges.
