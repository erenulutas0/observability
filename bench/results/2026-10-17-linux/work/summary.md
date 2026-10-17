# Benchmark 2026-10-17-153535

5 independent runs per variant, 50 connections, 30 s measured after 10 s warm-up, pipelining 1, `GET /users/42` returning about 3 KB of JSON after a fixed amount of CPU work (about 0.27 ms) (handler `work`). Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.

| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 1589.54 (1509.14–1711.47) | 0% | 26.75 (24.78–27.94) | 58.07 (52.75–60.85) | 78.87 (63.07–85.1) | 0% | 642.47 (596.71–676.16) | 135.92 (133.67–138.18) | 0 |
| ids-timing | 1406.14 (1261.24–2134.64) | -11.54% | 29.98 (22.02–35.48) | 65.3 (33.94–73.84) | 78.31 (45.27–106.61) | -0.71% | 730.73 (482.67–812.95) | 141.01 (138.09–142.13) | 0 |
| full-log | 1434.77 (884.94–1981.24) | -9.74% | 31.11 (23.76–50.71) | 59.12 (37.12–96.3) | 75.94 (48.56–131.07) | -3.71% | 724.77 (529.06–1167.68) | 143.81 (136.31–145.12) | 299.78 |
| pino-http | 1754.34 (1298–1892.47) | 10.37% | 25.15 (23.45–32.23) | 49.46 (41.55–72.32) | 80.84 (54.69–94.24) | 2.5% | 590.37 (548.27–795.64) | 142.69 (140.9–143.18) | 169 |

## Correctness checks

All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).

## Environment

```text
date: 2026-10-17T15:35:35.811Z
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
- The handler does a fixed amount of synchronous CPU work (about 0.27 ms) and returns about 3 KB of JSON. Real handlers also wait on I/O, which costs no CPU but holds connections; this handler does not model that.
- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.
- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.
