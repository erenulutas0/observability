# Run manifest — 2026-10-14-073334

One manifest for the whole session: every run shares the environment below. Fields follow bench/results/MANIFEST_TEMPLATE.md.

```text
runId: 2026-10-14-073334
scenarioId: baseline, ids-timing, full-log, pino-http
experimentType: baseline (first measurement of 0.1.0-dev.0)
date: 2026-10-14T07:33:33.825Z
sourceCommit: uncommitted working tree (dirty)
nodeVersion: v22.23.2
expressVersion: 4.22.3
expressObserveVersion: 0.1.0-dev.0
osVersion: Windows_NT 10.0.26200 (win32 x64) / Windows 11 Pro
hardware: 12th Gen Intel(R) Core(TM) i5-12500, 12 logical CPUs, 63.7 GB RAM
powerState: Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Y�ksek performans)
loadTool/version: autocannon 8.0.0
loadConfig: 50 connections, 15 s measured, 5 s warm-up, pipelining 1, GET /users/42
sinkDestination: server stdout redirected to a local temp file (deleted after counting)
clientPlatform: node-script (autocannon in the parent process)
networkCondition: loopback 127.0.0.1
repetitions: 3 per variant, fresh server process per run, variant order rotated per round
changedVariable: middleware configuration (variant)
correctnessResult: all checks passed
rawEvidencePaths: runs/*.json (full autocannon result per run, plus server stats and log counts)
knownBlindSpots: shared machine for client and server; background load not controlled; tiny handler exaggerates relative overhead; no pipe or network log destination tested
```

| Run | Variant | Round | Started | Problems |
|---|---|---|---|---|
| 1 | baseline | 1 | 2026-10-14T07:33:39.811Z | none |
| 2 | ids-timing | 1 | 2026-10-14T07:34:00.140Z | none |
| 3 | full-log | 1 | 2026-10-14T07:34:20.517Z | none |
| 4 | pino-http | 1 | 2026-10-14T07:34:41.060Z | none |
| 5 | ids-timing | 2 | 2026-10-14T07:35:01.589Z | none |
| 6 | full-log | 2 | 2026-10-14T07:35:22.679Z | none |
| 7 | pino-http | 2 | 2026-10-14T07:35:43.171Z | none |
| 8 | baseline | 2 | 2026-10-14T07:36:03.645Z | none |
| 9 | full-log | 3 | 2026-10-14T07:36:23.969Z | none |
| 10 | pino-http | 3 | 2026-10-14T07:36:44.351Z | none |
| 11 | baseline | 3 | 2026-10-14T07:37:04.942Z | none |
| 12 | ids-timing | 3 | 2026-10-14T07:37:25.256Z | none |
