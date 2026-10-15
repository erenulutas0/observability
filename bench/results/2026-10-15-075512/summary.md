# Benchmark 2026-10-15-075512

5 independent runs per variant, 50 connections, 30 s measured after 10 s warm-up, pipelining 1, `GET /users/42` returning about 3 KB of JSON after a fixed amount of CPU work (about 0.27 ms) (handler `work`). Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.

| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 1942.27 (1293.77–2298.81) | 0% | 25.42 (21.66–30.19) | 40.42 (30.76–104.41) | 54.17 (35.16–217.72) | 0% | 506.17 (431.6–617.96) | 124.21 (117.39–134.5) | 0 |
| ids-timing | 1750.47 (1419.47–2051.14) | -9.88% | 27.33 (25.02–31.73) | 54.05 (33.94–70.56) | 77.09 (40.1–116.43) | 42.31% | 555.31 (486.43–654.92) | 138.23 (135.66–140.71) | 0 |
| full-log | 1664.14 (1352.27–1906.2) | -14.32% | 24.26 (23.55–26.5) | 77.55 (61.05–102.67) | 123.42 (92.99–217.55) | 127.84% | 586.88 (530.44–688.56) | 139.38 (137.46–142.01) | 299.78 |
| pino-http | 1536.9 (1379.87–1892.27) | -20.87% | 27.61 (26.55–29.63) | 79.31 (49.22–92.8) | 130.97 (63.19–229.28) | 141.78% | 621.16 (539.56–646.23) | 142.5 (139.1–147) | 169 |

## Correctness checks

All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).

## Environment

```text
date: 2026-10-15T07:55:12.601Z
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
sourceCommit: 64f81f5
workingTreeDirty: true
```

## Caveats

- Load generator and server share one machine; autocannon is single-threaded and competes for CPU. Absolute numbers describe this machine only.
- Logs went to a file through the server process's stdout. Both the default sink and pino write synchronously in that setup. A pipe, a terminal or a remote collector behave differently.
- The handler does a fixed amount of synchronous CPU work (about 0.27 ms) and returns about 3 KB of JSON. Real handlers also wait on I/O, which costs no CPU but holds connections; this handler does not model that.
- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.
- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.
