# Run manifest — 2026-10-15-074040

One manifest for the whole session: every run shares the environment below. Fields follow bench/results/MANIFEST_TEMPLATE.md.

```text
runId: 2026-10-15-074040
scenarioId: baseline, ids-timing, full-log, pino-http
experimentType: overhead measurement
date: 2026-10-15T07:40:40.630Z
sourceCommit: 20622f5 (dirty)
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
| 1 | baseline | 1 | 2026-10-15T07:40:51.050Z | none |
| 2 | ids-timing | 1 | 2026-10-15T07:41:31.425Z | none |
| 3 | full-log | 1 | 2026-10-15T07:42:11.827Z | none |
| 4 | pino-http | 1 | 2026-10-15T07:42:52.302Z | none |
| 5 | ids-timing | 2 | 2026-10-15T07:43:32.711Z | none |
| 6 | full-log | 2 | 2026-10-15T07:44:13.046Z | none |
| 7 | pino-http | 2 | 2026-10-15T07:44:54.546Z | none |
| 8 | baseline | 2 | 2026-10-15T07:45:34.974Z | none |
| 9 | full-log | 3 | 2026-10-15T07:46:16.361Z | none |
| 10 | pino-http | 3 | 2026-10-15T07:46:57.804Z | none |
| 11 | baseline | 3 | 2026-10-15T07:47:38.242Z | none |
| 12 | ids-timing | 3 | 2026-10-15T07:48:18.680Z | none |
| 13 | pino-http | 4 | 2026-10-15T07:48:59.017Z | none |
| 14 | baseline | 4 | 2026-10-15T07:49:39.460Z | none |
| 15 | ids-timing | 4 | 2026-10-15T07:50:19.812Z | none |
| 16 | full-log | 4 | 2026-10-15T07:51:00.180Z | none |
| 17 | baseline | 5 | 2026-10-15T07:51:40.612Z | none |
| 18 | ids-timing | 5 | 2026-10-15T07:52:21.012Z | none |
| 19 | full-log | 5 | 2026-10-15T07:53:01.333Z | none |
| 20 | pino-http | 5 | 2026-10-15T07:53:41.780Z | none |
