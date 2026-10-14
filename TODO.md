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
- [ ] Owner review; merge feat/analyze-cli into main and push

## Repository

- [x] MIT LICENSE added with the GitHub handle erenulutas0 as copyright holder (change if a full name is preferred) — 2026-10-14
- [x] Published to https://github.com/erenulutas0/observability (main) — 2026-10-14

## Later (not scheduled)

- [ ] Performance candidates from the 2026-10-14 profiles, each to be measured before and after: replace per-request closures and Object.freeze in server-timing.js with a prototype-based object; measure the cost of the per-request req.route accessor (about 1.3% self time); compare on-finished with a plain finish/close listener (ADR-0001 option B, about 3% self time incl. ee-first)
- [ ] Re-run the benchmark on a quiet machine (no VM or Docker) and, if possible, on Linux, to narrow the ranges
- [ ] analyze: bounded-memory histogram mode for very large logs; per-group slowest; side-by-side comparison of two time windows or releases
- [ ] diagnostic-lab second wave: L3 bounded CPU, L4 prebuilt large JSON, L5 fast API + slow client, L6 one operation / several attempts; small Node client measuring clientAttemptMs / operationMs
- [ ] `doctor` integration checker
- [ ] React Native correlation demo (X-Request-Id + Server-Timing on the client)
- [ ] Express 5 compatibility
- [ ] Optional OpenTelemetry trace-id correlation

## History

- 2026-10-13 — Phase 1 started. Workspace contained only the original Turkish PLAN.md. Minimal structure and proposal documents created; implementation deferred pending review of ADR-0001.
- 2026-10-14 — Decisions accepted. Phase 2 implemented: request IDs, Server-Timing, option validation, internal warning channel. 70 tests passing on Node 22.23.2 / Express 4.22.3 (Windows 11). Mutation spot-check: 9 of 10 deliberate code breakages were caught; the one that was not (the post-flush "sealed" flag) has no externally observable effect because on-headers fires once. `npm audit` reports a moderate advisory in sprintf-js reached only through Jest's coverage tooling (dev-only); the suggested fix downgrades Jest to 25, so it was not applied.
- 2026-10-14 — Phase 3 implemented: access-log record, route templates, termination handling, sink isolation. 129 tests passing, stable across five consecutive runs (Node 22.23.2, Express 4.22.3, Windows 11). Mutation spot-check: 16 of 18 deliberate breakages caught; the two survivors have no observable effect (the belt-and-braces logged flag, and a field the record builder ignores). Smoke run found that Express 4's own default error handler prints stacks to stderr outside NODE_ENV=test; documented in ARCHITECTURE.md 4.5. ADR-0003 records the per-request req.route accessor.
- 2026-10-14 — Phase 4: diagnostic-lab demo and READMEs. lab:check passes all 12 scenarios with no duplicate records, and fails (exit 1) when the demo's mount config is removed. README quick start and the pino sink example were executed against the real package; pino adds pid and hostname by default, which the README now mentions.
- 2026-10-14 — Phase 5: benchmark harness and first session. Medians of 3 runs: baseline 8039 req/s and 128 µs server CPU per request; ids-timing 5135 req/s (-36%), 194 µs; full-log 3652 req/s (-55%), 287 µs; pino-http 4349 req/s (-46%), 222 µs. Ranges are wide because a VirtualBox VM and Docker were running. Profiles show no single hotspot: express-observe plus on-headers/on-finished account for about 12% (ids-timing) and 21% (full-log) of server self time, spread across per-request setup, synchronous file writes and on-finished. No code was changed in this phase.
- 2026-10-14 — v0.1 pushed to github.com/erenulutas0/observability (main, 5 commits after a scan for personal or sensitive data). MIT LICENSE added. analyze CLI implemented on branch feat/analyze-cli: 159 tests passing in total; mutation spot-check 10 of 11 caught, the survivor being a redundant safeguard (Node 22 readline already propagates stream errors; comment corrected).
