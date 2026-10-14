# Run manifest — copy next to each kept result file as `<runId>.manifest.md`

Fill every line. Use `not-used` or `unknown` rather than leaving a field blank. Numbers without raw output are not results.

```text
runId:
scenarioId:                 # L0..L8 for demo runs; baseline | ids-timing | full-log | pino-http for benchmarks
experimentType:             # proposed | baseline | candidate
date:
sourceCommit:
nodeVersion:
expressVersion:
expressObserveVersion:
osVersion:
hardware:                   # CPU model, core count, RAM
powerState:                 # plugged | battery | not-applicable
loadTool/version:           # e.g. autocannon 8.0.0
loadConfig:                 # connections, duration, pipelining, warmup
sinkDestination:            # stdout->file | stdout->/dev/null | custom
clientPlatform:             # node-script | browser | react-native | not-used
networkCondition:           # loopback | lan | throttled(...)
repetitions:
changedVariable:            # the single thing that differs from the baseline run
correctnessResult:          # tests green? record count == request count?
rawEvidencePaths:
knownBlindSpots:
```

Report format for each kept run: observation -> evidence -> alternative explanation -> missing data -> smallest next experiment.

Do not: average p95 values across runs; mix cold-start and warmed runs in one number; present a single machine's result as general; claim "zero overhead".
