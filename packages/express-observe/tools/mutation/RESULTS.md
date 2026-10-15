# Mutation check results

Run on 2026-10-15, Node v22.23.2, Windows 11, express-observe at branch feat/diagnostics (before commit). Re-run with `node tools/mutation/run.js`.

## diagnostics counters

tests: test/diagnostics.test.js

| Mutation | Outcome | Tests |
|---|---|---|
| started not counted | caught | 10 failed, 6 passed, 16 total |
| interrupted counted as finished | caught | 2 failed, 14 passed, 16 total |
| terminations not counted when logging is disabled | caught | 1 failed, 15 passed, 16 total |
| second instance on the same request counted again | caught | 1 failed, 15 passed, 16 total |
| emitted not counted | caught | 12 failed, 4 passed, 16 total |
| dropped not counted | caught | 2 failed, 14 passed, 16 total |
| sink errors not counted | caught | 4 failed, 12 passed, 16 total |
| sink promises never leave pending | caught | 2 failed, 14 passed, 16 total |
| thenable settled more than once | caught | 1 failed, 15 passed, 16 total |
| rate-limited warnings not counted | caught | 1 failed, 15 passed, 16 total |
| inFlight ignores interrupted requests | caught | 2 failed, 14 passed, 16 total |

## doctor: safety limits and checks (ADR-0005)

tests: test/doctor.test.js

| Mutation | Outcome | Tests |
|---|---|---|
| remote target allowed without --allow-remote | caught | 1 failed, 39 passed, 40 total |
| loopback check accepts any name starting with 127. | caught | 1 failed, 39 passed, 40 total |
| probes use POST | caught | 4 failed, 36 passed, 40 total |
| no identifying User-Agent | caught | 1 failed, 39 passed, 40 total |
| three probes per path | caught | 4 failed, 36 passed, 40 total |
| no limit on the number of paths | caught | 1 failed, 39 passed, 40 total |
| credentials in the target URL allowed | caught | 1 failed, 39 passed, 40 total |
| no response body cap | caught | 1 failed, 39 passed, 40 total |
| no hard per-request deadline | caught | 1 failed, 39 passed, 40 total |
| answered probe with cut body counted as no response | caught | 1 failed, 39 passed, 40 total |
| vacuous pass when nothing answered | caught | 1 failed, 39 passed, 40 total |
| duplicate log records ignored | caught | 1 failed, 39 passed, 40 total |
| leaked markers ignored | caught | 2 failed, 38 passed, 40 total |
| raw URL as route ignored | caught | 1 failed, 39 passed, 40 total |
| null route on success ignored | caught | 1 failed, 39 passed, 40 total |
| repeated request IDs ignored | caught | 1 failed, 39 passed, 40 total |

## eventLoopDelayMs sampler

tests: test/event-loop.test.js

| Mutation | Outcome | Tests |
|---|---|---|
| overdue tick not counted | caught | 2 failed, 5 passed, 7 total |
| no look-back before middleware entry | caught | 1 failed, 6 passed, 7 total |
| sampler never started | caught | 4 failed, 3 passed, 7 total |
| lateness not recorded | caught | 1 failed, 6 passed, 7 total |
| no-measurement case reported as 0 instead of null | caught | 1 failed, 6 passed, 7 total |

## route labels and privacy

tests: test/route-template.test.js test/privacy.test.js

| Mutation | Outcome | Tests |
|---|---|---|
| route and baseUrl read at termination instead of at match time | caught | 2 failed, 2 skipped, 31 passed, 35 total |
| unmatched mount falls back to the concrete baseUrl | caught | 4 failed, 2 skipped, 29 passed, 35 total |
| mount literals compared case-sensitively | caught | 1 failed, 2 skipped, 32 passed, 35 total |
| explicit label accepted without validation | caught | 1 failed, 2 skipped, 32 passed, 35 total |

## access log: termination and status

tests: test/lifecycle.test.js test/sink.test.js

| Mutation | Outcome | Tests |
|---|---|---|
| no check for a response already destroyed at entry | caught | 1 failed, 1 skipped, 33 passed, 35 total |
| no close listener | caught | 5 failed, 1 skipped, 29 passed, 35 total |
| close without finish reported as finished | caught | 5 failed, 1 skipped, 29 passed, 35 total |
| already-destroyed response reported as finished | caught | 1 failed, 1 skipped, 33 passed, 35 total |
| status reported even when headers were never sent | caught | 3 failed, 1 skipped, 31 passed, 35 total |
| per-response logged flag removed | survived (equivalent) | 1 skipped, 34 passed, 35 total — equivalent: onResponseEnd already calls the listener at most once (its own done flag); the logged flag is belt-and-braces |

All non-equivalent mutations were caught.
