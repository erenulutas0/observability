# Run manifest — 2026-10-17-153535

One manifest for the whole session: every run shares the environment below. Fields follow bench/results/MANIFEST_TEMPLATE.md.

```text
runId: 2026-10-17-153535
scenarioId: baseline, ids-timing, full-log, pino-http
experimentType: overhead measurement
date: 2026-10-17T15:35:35.811Z
sourceCommit: uncommitted working tree
nodeVersion: v22.23.2
expressVersion: 4.22.3
expressObserveVersion: 0.1.0-dev.0
osVersion: Linux 6.6.87.2-microsoft-standard-WSL2 (linux x64) / #1 SMP PREEMPT_DYNAMIC Thu Jun  5 18:30:46 UTC 2025
hardware: 12th Gen Intel(R) Core(TM) i5-12500, 12 logical CPUs, 31.2 GB RAM
powerState: not recorded
loadTool/version: autocannon 8.0.0
loadConfig: 50 connections, 30 s measured, 10 s warm-up, pipelining 1, GET /users/42, handler work
sinkDestination: server stdout redirected to a local temp file (deleted after counting)
clientPlatform: node-script (autocannon in the parent process)
networkCondition: loopback 127.0.0.1
repetitions: 5 per variant, fresh server process per run, variant order rotated per round
changedVariable: middleware configuration (variant)
correctnessResult: all checks passed
rawEvidencePaths: runs/*.json (full autocannon result per run, plus server stats and log counts)
knownBlindSpots: shared machine for client and server; background load not controlled; tiny handler exaggerates relative overhead; no pipe or network log destination tested
```

| Run | Variant | Round | Started | Problems |
|---|---|---|---|---|
| 1 | baseline | 1 | 2026-10-17T15:35:46.007Z | none |
| 2 | ids-timing | 1 | 2026-10-17T15:36:26.361Z | none |
| 3 | full-log | 1 | 2026-10-17T15:37:07.675Z | none |
| 4 | pino-http | 1 | 2026-10-17T15:37:48.949Z | none |
| 5 | ids-timing | 2 | 2026-10-17T15:38:30.181Z | none |
| 6 | full-log | 2 | 2026-10-17T15:39:11.384Z | none |
| 7 | pino-http | 2 | 2026-10-17T15:39:51.630Z | none |
| 8 | baseline | 2 | 2026-10-17T15:40:32.012Z | none |
| 9 | full-log | 3 | 2026-10-17T15:41:13.538Z | none |
| 10 | pino-http | 3 | 2026-10-17T15:41:53.941Z | none |
| 11 | baseline | 3 | 2026-10-17T15:42:34.212Z | none |
| 12 | ids-timing | 3 | 2026-10-17T15:43:14.500Z | none |
| 13 | pino-http | 4 | 2026-10-17T15:43:55.792Z | none |
| 14 | baseline | 4 | 2026-10-17T15:44:37.093Z | none |
| 15 | ids-timing | 4 | 2026-10-17T15:45:18.344Z | none |
| 16 | full-log | 4 | 2026-10-17T15:45:59.307Z | none |
| 17 | baseline | 5 | 2026-10-17T15:46:39.770Z | none |
| 18 | ids-timing | 5 | 2026-10-17T15:47:21.135Z | none |
| 19 | full-log | 5 | 2026-10-17T15:48:02.308Z | none |
| 20 | pino-http | 5 | 2026-10-17T15:48:43.574Z | none |
