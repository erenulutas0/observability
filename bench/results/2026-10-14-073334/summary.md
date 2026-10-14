# Benchmark 2026-10-14-073334

3 independent runs per variant, 50 connections, 15 s measured after 5 s warm-up, pipelining 1, `GET /users/42` returning a small JSON body. Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.

| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 8038.67 (7040.27–8283.74) | 0% | 5.71 (5.35–6.18) | 13.93 (13.87–17.03) | 21.1 (21.09–26.66) | 0% | 128.24 (120.91–137.24) | 127.63 (124.7–131.62) | 0 |
| ids-timing | 5135.07 (3915.47–5685.94) | -36.12% | 9.12 (8.33–11.48) | 20.93 (18.76–28.86) | 33.15 (30.32–44.42) | 57.11% | 193.63 (176.16–214.79) | 131.9 (130.92–138.86) | 0 |
| full-log | 3652.2 (2668.27–4479.14) | -54.57% | 9.67 (7.61–12.41) | 43.85 (38.3–56.99) | 81.91 (65.55–119.34) | 288.2% | 287.27 (232.44–333.42) | 139.07 (131.25–155.52) | 299.78 |
| pino-http | 4349.07 (3151.27–5245.67) | -45.9% | 7.38 (6.13–10.02) | 35.57 (28.21–51.54) | 59.22 (46.85–83.33) | 180.66% | 222.35 (199.65–287.63) | 162.71 (155.45–168.25) | 169 |

## Correctness checks

All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).

## Environment

```text
date: 2026-10-14T07:33:33.825Z
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
powerPlan: Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Y�ksek performans)
sourceCommit: uncommitted working tree
workingTreeDirty: true
```

## Caveats

- Load generator and server share one machine; autocannon is single-threaded and competes for CPU. Absolute numbers describe this machine only.
- Logs went to a file through the server process's stdout. Both the default sink and pino write synchronously in that setup. A pipe, a terminal or a remote collector behave differently.
- The handler does almost nothing, so middleware cost is a large share of each request. In a real application the relative overhead is smaller; the absolute cost per request is the more transferable number.
- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.
- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.
