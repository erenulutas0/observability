# TODO

Status markers: `[ ]` pending · `[~]` in progress · `[x]` done · `[-]` dropped (with reason).

## Phase 1 — Architecture and review

- [x] Inspect workspace (only PLAN.md existed) — 2026-10-13
- [x] Create minimal structure: packages/express-observe/{src,test}, demo/, bench/results/, docs/decisions/, root package.json (npm workspaces), .gitignore, .editorconfig, `git init` — 2026-10-13
- [x] Write ARCHITECTURE.md (all sections marked [proposed]) — 2026-10-13
- [x] Write AGENTS.md — 2026-10-13
- [x] Write docs/decisions/0001-phase1-architecture.md with the five open decisions — 2026-10-13
- [x] Align PLAN.md with the agreed v0.1 contract (termination field, dependency policy, demo scope, 404 route rule) — 2026-10-13
- [x] Read owner's research notes; fold the project-relevant parts into ARCHITECTURE.md §4.4, §9, §10, PLAN.md and docs/decisions/0002 (headerDurationMs, measurement vocabulary, diagnostic-lab demo, run manifest) — 2026-10-13
- [x] bench/results/MANIFEST_TEMPLATE.md — 2026-10-13
- [x] Owner approved all recommended options of ADR-0001 (1–5) and ADR-0002 (1–3) — 2026-10-14
- [x] Both ADRs marked Accepted with an Outcome section; TUM_ARASTIRMA.md added to .gitignore — 2026-10-14

## Phase 2 — Request IDs and Server-Timing

- [x] packages/express-observe/package.json (name, main, peerDeps, jest config); on-headers 1.1.0, dev: express 4.22.3, jest 30.5.2, supertest 7.3.1 — 2026-10-14
- [x] src/request-id.js: isValidRequestId, generateRequestId, resolveRequestId -> { id, source } — 2026-10-14
- [x] src/server-timing.js: timer registry, limits, sanitized desc, header merge — 2026-10-14
- [x] src/index.js: option validation + middleware wiring (on-headers hook; no logging yet) — 2026-10-14
- [x] src/logger.js (partial): rate-limited stderr warning for the middleware's own problems — 2026-10-14
- [x] Tests: valid / invalid / oversized / injection-attempt incoming IDs; raw-socket UTF-8 and duplicate header; existing req.id kept / replaced; 1000 concurrent IDs unique; options validation — 2026-10-14
- [x] Tests: Server-Timing format; streaming and flushHeaders; writeHead; 404 and next(err); duplicate start; end without start; unfinished timer; calls after headersSent; invalid names/durations; maxEntries; header merge; disabled mode — 2026-10-14
- [x] Run suite (70/70 passing), mutation spot-check, ARCHITECTURE.md markers updated — 2026-10-14
- [ ] Owner review of Phase 2 before starting Phase 3

## Phase 3 — Logging and lifecycle

- [x] Add on-finished 2.4.1 as a runtime dependency — 2026-10-14
- [x] src/logger.js: record builder, opt-in extend (core fields win), default stdout sink, sink isolation for sync throw and async rejection, rate-limited warnings — 2026-10-14
- [x] src/route-template.js: explicit label -> resolver -> leaf + mounts -> null; route captured at match time (ADR-0003) — 2026-10-14
- [x] Wire on-finished; termination classification; status null when headers unsent; headerDurationMs from the on-headers hook — 2026-10-14
- [x] Tests (lifecycle): normal record shape; finish+close gives one record; 200 concurrent; double mount; log disabled; next(err) reaches the app handler; sync throw; unmatched 404; matched-handler 404; next(err) after headers; real-socket abort before headers with a late response; real-socket abort mid-body; never-responding handler; L1 vs L2 — 2026-10-14
- [x] Tests (routes): params, regex constraint, RegExp and array routes, middleware responses, query strings, param and static mounts, trailing slash, case, same-length mounts, two-level nesting, nested next(err), locals label, resolver, validation — 2026-10-14
- [x] Tests (sink): default stdout line, object record, sync throw, async rejection without unhandledRejection, slow sink, rate-limited stderr without message, throwing onSinkError, extend add / no override / throw / non-object / unserializable — 2026-10-14
- [x] Tests (privacy): 14 planted sentinels (path and mount params, query, email, bearer token, cookie, password, body, forwarded IP, user agent, custom header, error message, response body, user id) absent from stdout and stderr — 2026-10-14
- [x] Run suite (129/129, five consecutive clean runs), mutation spot-check, end-to-end smoke run, docs updated — 2026-10-14
- [ ] Owner review of Phase 3 before starting Phase 4

## Phase 4 — Demo and documentation

- [x] demo/ as an npm workspace (express 4.22.3 + linked express-observe); root scripts demo, lab, lab:check — 2026-10-14
- [x] demo/app.js (diagnostic-lab): L0, L1 (+ matched-route 404), L2, L7 before headers and mid-body, L8 throwing / rejecting / slow sink, app error handler returning the request ID, unmatched 404, nested router at a parameterized mount; allowlisted delays only, loopback bind — 2026-10-14
- [x] demo/lab.js: real client per scenario, clientAttemptMs vs record, reading derived from the record alone, --check assertions, duplicate-record check — 2026-10-14
- [x] demo/README.md: per scenario, what the record shows and what it must not be read as — 2026-10-14
- [x] packages/express-observe/README.md: quick start, record schema, measurement vocabulary, options, request IDs, Server-Timing, route labels and mounts, sinks (pino example), extend, privacy, errors, limitations — 2026-10-14
- [x] Root README.md as a short pointer — 2026-10-14
- [x] Verified: lab:check passes and fails when the mount config is broken; app.js runs standalone (curl); README quick start and pino example executed — 2026-10-14
- [ ] Owner review of Phase 4 before starting Phase 5

## Phase 5 — Benchmark

- [x] bench/ as an npm workspace: autocannon 8.0.0, pino-http 11.0.0 (pino 10.4.0), express 4.22.3 — 2026-10-14
- [x] bench/server.js: four variants (baseline, ids-timing, full-log, pino-http), fresh child process per run, CPU and RSS over IPC — 2026-10-14
- [x] bench/run.js: warm-up, rotated variant order, p50/p95/p99 from every response time, per-run correctness checks (errors, non-2xx, headers, log lines = requests), raw JSON per run, summary and manifest — 2026-10-14
- [x] bench/profile.js: CPU profile of one variant, self time per function — 2026-10-14
- [x] Session 2026-10-14-073334: 4 variants x 3 rounds, 15 s measured, 50 connections; all correctness checks passed; profiles saved — 2026-10-14
- [x] Summary in package README with caveats; bench/README.md documents method — 2026-10-14
- [ ] Owner review of Phase 5 and of v0.1 as a whole

## analyze CLI (branch feat/analyze-cli)

- [x] ADR-0004: same package bin, input rules, grouping, finished-only percentiles with minimum samples, notes, terminal safety, exit codes — 2026-10-14
- [x] bin/express-observe.js, src/analyze.js, src/analyze-format.js; package.json bin and files — 2026-10-14
- [x] 30 tests: exact percentiles, minimum samples, interrupted handling, status classes, unknown routes, skip reasons, wrapped records, CRLF, stdin, multiple files, time window, grouping, sorting, top, slowest, escape-sequence safety, exit codes, end to end with the real middleware — 2026-10-14
- [x] demo/lab.js --log, README sections (package and demo), ARCHITECTURE section 11 — 2026-10-14
- [x] Merged into main (fast-forward) and pushed — 2026-10-14

## doctor CLI (branch feat/doctor)

- [x] ADR-0005: black-box design, security boundaries, checks, exit codes — 2026-10-14
- [x] src/doctor.js and the doctor subcommand; shared record validation with analyze — 2026-10-14
- [x] 40 tests: healthy integration, ten misconfigurations (no middleware, late registration, double logging, missing mount, URL and header leaks through extend, replayed IDs, raw-path labels, malformed Server-Timing, disabled timing, client-ID trust), unreadable log, unreachable server, safety limits (GET only, no credentials, request budget, no redirects, body cap, hard deadline, remote refusal, usage errors), loopback detection, Server-Timing grammar — 2026-10-14
- [x] Fixed during testing: per-request timeout was an idle timeout, so a trickling server could hold doctor open; now a hard deadline with --timeout — 2026-10-14
- [x] Merged into main (fast-forward) and pushed — 2026-10-14

## React Native correlation demo (branch feat/react-native-demo)

- [x] ADR-0006: shared correlation module, per-attempt IDs, trust decision, vocabulary, app outside the workspace — 2026-10-14
- [x] correlation.js, join.js, join-cli.js, server.js, node-client.js as workspace examples/react-native-correlation — 2026-10-14
- [x] 16 tests over real HTTP: single attempt, Server-Timing wait, retry with two IDs, client timeout joined to an interrupted record, both trust settings, unreachable server, invalid ID generator, path rule, attempt cap, lenient Server-Timing parsing, Metro console extraction, wrapped server records, duplicate records, output sanitizing, full session through the join CLI — 2026-10-14
- [x] Expo SDK 57 app (App.js, metro.config.js); expo install --check clean; expo export --platform android builds Hermes bytecode containing the shared module — 2026-10-14
- [x] Ran on an Android 15 emulator via Expo Go 57: five scenarios, six attempts, all joined; results and screenshot in examples/react-native-correlation/results/ — 2026-10-14
- [x] Fixed: SafeAreaView deprecated in RN 0.86 and overlapping the Android status bar; switched to react-native-safe-area-context — 2026-10-14
- [ ] Run on a physical phone over a real network, and on iOS
- [x] Merged into main (fast-forward) and pushed — 2026-10-14

## Performance (branch perf/hot-path)

- [x] bench/ab.js (HTTP A/B against a git ref) and bench/micro.js (in-process, single-threaded GC) with A-vs-A noise floors — 2026-10-14
- [x] Fixed: termination misreported as finished when the client left before observe() ran (found by a new test; failed on main) — 2026-10-14
- [x] Replaced on-finished with finish/close listeners: micro 12/12 −8.6%, HTTP 6/6 −16% server CPU; on-headers is the only runtime dependency (ADR-0007) — 2026-10-14
- [-] server-timing allocation cuts: inconclusive (9/12, 7/12), not kept — 2026-10-14
- [-] req.route accessor on app.request instead of per request: inconclusive (8/12, 4/6) and touches an Express prototype, not kept; per-request accessor costs about 11 µs (ADR-0003 addendum) — 2026-10-14
- [ ] Owner review; merge perf/hot-path into main and push
- [ ] Re-measure on a quiet machine (no VM, no emulator) to resolve the inconclusive candidates

## Repository

- [x] MIT LICENSE added with the GitHub handle erenulutas0 as copyright holder (change if a full name is preferred) — 2026-10-14
- [x] Published to https://github.com/erenulutas0/observability (main) — 2026-10-14

## Later (not scheduled)

- [ ] Re-run the benchmark on a quiet machine (no VM or Docker) and, if possible, on Linux, to narrow the ranges
- [ ] analyze: bounded-memory histogram mode for very large logs; per-group slowest; side-by-side comparison of two time windows or releases
- [ ] diagnostic-lab second wave: L3 bounded CPU, L4 prebuilt large JSON, L5 fast API + slow client, L6 one operation / several attempts; small Node client measuring clientAttemptMs / operationMs
- [ ] Express 5 compatibility
- [ ] Optional OpenTelemetry trace-id correlation

## History

- 2026-10-13 — Phase 1 started. Workspace contained only the original Turkish PLAN.md. Minimal structure and proposal documents created; implementation deferred pending review of ADR-0001.
- 2026-10-14 — Decisions accepted. Phase 2 implemented: request IDs, Server-Timing, option validation, internal warning channel. 70 tests passing on Node 22.23.2 / Express 4.22.3 (Windows 11). Mutation spot-check: 9 of 10 deliberate code breakages were caught; the one that was not (the post-flush "sealed" flag) has no externally observable effect because on-headers fires once. `npm audit` reports a moderate advisory in sprintf-js reached only through Jest's coverage tooling (dev-only); the suggested fix downgrades Jest to 25, so it was not applied.
- 2026-10-14 — Phase 3 implemented: access-log record, route templates, termination handling, sink isolation. 129 tests passing, stable across five consecutive runs (Node 22.23.2, Express 4.22.3, Windows 11). Mutation spot-check: 16 of 18 deliberate breakages caught; the two survivors have no observable effect (the belt-and-braces logged flag, and a field the record builder ignores). Smoke run found that Express 4's own default error handler prints stacks to stderr outside NODE_ENV=test; documented in ARCHITECTURE.md 4.5. ADR-0003 records the per-request req.route accessor.
- 2026-10-14 — Phase 4: diagnostic-lab demo and READMEs. lab:check passes all 12 scenarios with no duplicate records, and fails (exit 1) when the demo's mount config is removed. README quick start and the pino sink example were executed against the real package; pino adds pid and hostname by default, which the README now mentions.
- 2026-10-14 — Phase 5: benchmark harness and first session. Medians of 3 runs: baseline 8039 req/s and 128 µs server CPU per request; ids-timing 5135 req/s (-36%), 194 µs; full-log 3652 req/s (-55%), 287 µs; pino-http 4349 req/s (-46%), 222 µs. Ranges are wide because a VirtualBox VM and Docker were running. Profiles show no single hotspot: express-observe plus on-headers/on-finished account for about 12% (ids-timing) and 21% (full-log) of server self time, spread across per-request setup, synchronous file writes and on-finished. No code was changed in this phase.
- 2026-10-14 — v0.1 pushed to github.com/erenulutas0/observability (main, 5 commits after a scan for personal or sensitive data). MIT LICENSE added. analyze CLI implemented on branch feat/analyze-cli: 159 tests passing in total; mutation spot-check 10 of 11 caught, the survivor being a redundant safeguard (Node 22 readline already propagates stream errors; comment corrected).
- 2026-10-14 — analyze CLI merged into main and pushed. doctor implemented on branch feat/doctor: 40 tests, 199 in total; mutation spot-check 16 of 16 caught. Found and fixed during testing: the per-request timeout was an idle timeout that a trickling server could defeat. Verified against the running demo: all 9 checks pass. Git Bash rewrites Unix-looking arguments; documented in the README.
- 2026-10-14 — doctor merged into main and pushed. React Native correlation demo on branch feat/react-native-demo: shared correlation module with 16 tests (215 in total across workspaces), Expo SDK 57 app bundled for Android but not run on a device; no emulator image or device was available.
- 2026-10-14 — Owner approved an emulator. Installed an Android 35 x86_64 emulator image and a dedicated AVD. The app ran in Expo Go; all six attempts of a session joined with the server log. Fixed the SafeAreaView deprecation found on the device.
- 2026-10-14 — React Native demo merged into main. Emulator data kept off the system drive: AVDs, the system image and the Expo cache live on a data drive, verified by a boot that changed system-drive free space by 0 MB.
- 2026-10-14 — Performance work on perf/hot-path: new A/B and micro benchmarks with noise floors; a termination bug fixed; on-finished replaced (kept, clear win); two candidates rejected as inconclusive. 206 package tests passing. Full table: bench/results/micro-2026-10-14/README.md.
