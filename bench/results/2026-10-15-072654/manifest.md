# Run manifest — 2026-10-15-072654

One manifest for the whole session: every run shares the environment below. Fields follow bench/results/MANIFEST_TEMPLATE.md.

```text
runId: 2026-10-15-072654
scenarioId: baseline, ids-timing, full-log, pino-http
experimentType: overhead measurement
date: 2026-10-15T07:26:54.534Z
sourceCommit: 20622f5 (dirty)
nodeVersion: v22.23.2
expressVersion: 4.22.3
expressObserveVersion: 0.1.0-dev.0
osVersion: Windows_NT 10.0.26200 (win32 x64) / Windows 11 Pro
hardware: 12th Gen Intel(R) Core(TM) i5-12500, 12 logical CPUs, 63.7 GB RAM
powerState: Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Yüksek performans)
loadTool/version: autocannon 8.0.0
loadConfig: 50 connections, 30 s measured, 10 s warm-up, pipelining 1, GET /users/42, handler tiny
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
| 1 | baseline | 1 | 2026-10-15T07:27:06.003Z | none |
| 2 | ids-timing | 1 | 2026-10-15T07:27:47.358Z | none |
| 3 | full-log | 1 | 2026-10-15T07:28:28.714Z | none |
| 4 | pino-http | 1 | 2026-10-15T07:29:10.213Z | none |
| 5 | ids-timing | 2 | 2026-10-15T07:29:51.756Z | none |
| 6 | full-log | 2 | 2026-10-15T07:30:33.100Z | none |
| 7 | pino-http | 2 | 2026-10-15T07:31:13.654Z | none |
| 8 | baseline | 2 | 2026-10-15T07:31:55.328Z | none |
| 9 | full-log | 3 | 2026-10-15T07:32:36.690Z | none |
| 10 | pino-http | 3 | 2026-10-15T07:33:18.135Z | none |
| 11 | baseline | 3 | 2026-10-15T07:34:00.519Z | none |
| 12 | ids-timing | 3 | 2026-10-15T07:34:41.871Z | none |
| 13 | pino-http | 4 | 2026-10-15T07:35:22.188Z | none |
| 14 | baseline | 4 | 2026-10-15T07:36:03.711Z | none |
| 15 | ids-timing | 4 | 2026-10-15T07:36:44.052Z | none |
| 16 | full-log | 4 | 2026-10-15T07:37:25.384Z | none |
| 17 | baseline | 5 | 2026-10-15T07:38:06.857Z | none |
| 18 | ids-timing | 5 | 2026-10-15T07:38:47.268Z | none |
| 19 | full-log | 5 | 2026-10-15T07:39:28.581Z | none |
| 20 | pino-http | 5 | 2026-10-15T07:40:10.023Z | none |
