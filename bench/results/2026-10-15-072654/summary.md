# Benchmark 2026-10-15-072654

5 independent runs per variant, 50 connections, 30 s measured after 10 s warm-up, pipelining 1, `GET /users/42` returning a small JSON body, returned at once (handler `tiny`). Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.

| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 9727.27 (8974.47–11090.14) | 0% | 3.89 (3.1–4.62) | 13.64 (13.39–13.84) | 18.49 (17.7–18.87) | 0% | 106.06 (95.19–117.27) | 132.33 (125.25–133.44) | 0 |
| ids-timing | 7649 (7343.14–8105.2) | -21.37% | 4.8 (4.24–5.05) | 17.55 (17.55–17.98) | 23.67 (23.06–23.95) | 28.02% | 138.68 (134.14–144.95) | 139.04 (136.91–139.95) | 0 |
| full-log | 5791.34 (5440.27–6600.4) | -40.46% | 5.68 (5.2–6.14) | 30.6 (27.25–33) | 49.52 (42.82–52.09) | 167.82% | 184.24 (166.93–202.35) | 152.03 (150.05–157.12) | 299.75 |
| pino-http | 6645.87 (5939.8–7374.27) | -31.68% | 4.96 (4.59–5.33) | 25.15 (24.15–27.93) | 35.86 (34.46–41.24) | 93.94% | 158.83 (148.58–176.48) | 231.02 (225.07–259.67) | 169 |

## Correctness checks

All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).

## Environment

```text
date: 2026-10-15T07:26:54.534Z
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
- The handler does almost nothing, so middleware cost is a large share of each request. In a real application the relative overhead is smaller; the absolute cost per request is the more transferable number.
- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.
- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.
