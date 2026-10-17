# Benchmark 2026-10-17-152156

5 independent runs per variant, 50 connections, 30 s measured after 10 s warm-up, pipelining 1, `GET /users/42` returning a small JSON body, returned at once (handler `tiny`). Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.

| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 8111 (7200.04–9789.6) | 0% | 5.35 (4.51–5.83) | 12.1 (8.83–15.53) | 16.97 (13.65–21.22) | 0% | 131.22 (109.51–146.42) | 127.49 (127.02–128.3) | 0 |
| ids-timing | 6916.3 (4240.61–7463.67) | -14.73% | 6.51 (6.1–9.1) | 12.48 (10.5–28.02) | 18.68 (15.56–34.33) | 10.08% | 158.72 (147.69–250.65) | 132.57 (131.95–132.92) | 0 |
| full-log | 4808.37 (2222.67–5956.54) | -40.72% | 9.31 (7.64–21.01) | 18.76 (13.02–37.88) | 25.39 (18.4–47.53) | 49.62% | 233.72 (194.17–478.1) | 132.64 (131.23–134.51) | 299.79 |
| pino-http | 6200.27 (3596.24–6462.4) | -23.56% | 7.26 (7.13–11.85) | 13.68 (12.23–27.35) | 19.78 (17.23–37.19) | 16.56% | 180.47 (173.51–300.44) | 135.19 (134.61–136.04) | 169 |

## Correctness checks

All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).

## Environment

```text
date: 2026-10-17T15:21:56.106Z
nodeVersion: v22.23.2
expressVersion: 4.22.3
expressObserveVersion: 0.1.0-dev.0
autocannonVersion: 8.0.0
pinoHttpVersion: 11.0.0
pinoVersion: 10.4.0
os: Linux 6.6.87.2-microsoft-standard-WSL2 (linux x64)
osVersion: #1 SMP PREEMPT_DYNAMIC Thu Jun  5 18:30:46 UTC 2025
cpuModel: 12th Gen Intel(R) Core(TM) i5-12500
logicalCpus: 12
totalMemGb: 31.2
powerPlan: null
sourceCommit: uncommitted working tree
workingTreeDirty: false
```

## Caveats

- Load generator and server share one machine; autocannon is single-threaded and competes for CPU. Absolute numbers describe this machine only.
- Logs went to a file through the server process's stdout. Both the default sink and pino write synchronously in that setup. A pipe, a terminal or a remote collector behave differently.
- The handler does almost nothing, so middleware cost is a large share of each request. In a real application the relative overhead is smaller; the absolute cost per request is the more transferable number.
- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.
- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.
