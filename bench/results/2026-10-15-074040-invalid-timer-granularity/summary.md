# Benchmark 2026-10-15-074040

5 independent runs per variant, 50 connections, 30 s measured after 10 s warm-up, pipelining 1, `GET /users/42` returning about 3 KB of JSON after a 2 ms asynchronous wait (handler `work`). Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.

| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 3386.94 (3363.4–3435.4) | 0% | 15.49 (15.46–15.52) | 17.32 (17.2–17.35) | 20.27 (19.66–21.07) | 0% | 124.65 (113.52–163.31) | 119.58 (118.57–120.34) | 0 |
| ids-timing | 4525.77 (3690.74–4607.67) | 33.62% | 9.09 (8.93–11.05) | 18.02 (17.69–28.13) | 21.99 (21.88–36.43) | 8.49% | 168.26 (155.27–206.95) | 124.82 (123.78–125.71) | 0 |
| full-log | 4201.07 (4105.61–4324.7) | 24.04% | 10.62 (10.35–10.93) | 19.69 (18.66–20.8) | 23.81 (22.77–23.86) | 17.46% | 197.21 (175.13–229.05) | 124.54 (124.06–126.09) | 300.41 |
| pino-http | 5586.77 (5207.61–5908.4) | 64.95% | 7.84 (7.5–8.51) | 15.97 (15.7–17.48) | 21.8 (21.13–24.5) | 7.55% | 180.62 (165.16–195.21) | 126.08 (125.69–127.19) | 169.12 |

## Correctness checks

All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).

## Environment

```text
date: 2026-10-15T07:40:40.630Z
nodeVersion: v22.23.2
expressVersion: 4.22.3
expressObserveVersion: 0.1.0-dev.0
autocannonVersion: 8.0.0
pinoHttpVersion: 11.0.0
pinoVersion: 10.4.0
os: Windows_NT 10.0.26200 (win32 x64)
osVersion: Windows 11 Pro
cpuModel: 12th Gen Intel(R) Core(TM) i5-12500
logicalCpus: 12
totalMemGb: 63.7
powerPlan: Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Yüksek performans)
sourceCommit: 20622f5
workingTreeDirty: true
```

## Caveats

- Load generator and server share one machine; autocannon is single-threaded and competes for CPU. Absolute numbers describe this machine only.
- Logs went to a file through the server process's stdout. Both the default sink and pino write synchronously in that setup. A pipe, a terminal or a remote collector behave differently.
- The handler waits 2 ms on a timer and serializes about 3 KB of JSON. That is closer to a real endpoint, but a real database call also costs CPU, which this handler does not.
- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.
- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.
