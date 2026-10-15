# Run manifest — 2026-10-15-075512

One manifest for the whole session: every run shares the environment below. Fields follow bench/results/MANIFEST_TEMPLATE.md.

```text
runId: 2026-10-15-075512
scenarioId: baseline, ids-timing, full-log, pino-http
experimentType: overhead measurement
date: 2026-10-15T07:55:12.601Z
sourceCommit: 64f81f5 (dirty)
nodeVersion: v22.23.2
expressVersion: 4.22.3
expressObserveVersion: 0.1.0-dev.0
osVersion: Windows_NT 10.0.26200 (win32 x64) / Windows 11 Pro
hardware: 12th Gen Intel(R) Core(TM) i5-12500, 12 logical CPUs, 63.7 GB RAM
powerState: Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Yüksek performans)
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
| 1 | baseline | 1 | 2026-10-15T07:55:23.111Z | none |
| 2 | ids-timing | 1 | 2026-10-15T07:56:03.403Z | none |
| 3 | full-log | 1 | 2026-10-15T07:56:47.750Z | none |
| 4 | pino-http | 1 | 2026-10-15T07:57:28.193Z | none |
| 5 | ids-timing | 2 | 2026-10-15T07:58:09.568Z | none |
| 6 | full-log | 2 | 2026-10-15T07:58:50.959Z | none |
| 7 | pino-http | 2 | 2026-10-15T07:59:31.299Z | none |
| 8 | baseline | 2 | 2026-10-15T08:00:12.655Z | none |
| 9 | full-log | 3 | 2026-10-15T08:00:53.044Z | none |
| 10 | pino-http | 3 | 2026-10-15T08:01:34.523Z | none |
| 11 | baseline | 3 | 2026-10-15T08:02:16.462Z | none |
| 12 | ids-timing | 3 | 2026-10-15T08:02:57.454Z | none |
| 13 | pino-http | 4 | 2026-10-15T08:03:37.911Z | none |
| 14 | baseline | 4 | 2026-10-15T08:04:18.389Z | none |
| 15 | ids-timing | 4 | 2026-10-15T08:04:59.755Z | none |
| 16 | full-log | 4 | 2026-10-15T08:05:41.066Z | none |
| 17 | baseline | 5 | 2026-10-15T08:06:21.421Z | none |
| 18 | ids-timing | 5 | 2026-10-15T08:07:01.838Z | none |
| 19 | full-log | 5 | 2026-10-15T08:07:42.124Z | none |
| 20 | pino-http | 5 | 2026-10-15T08:08:23.541Z | none |
