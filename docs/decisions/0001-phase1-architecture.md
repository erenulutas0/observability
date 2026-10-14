# ADR-0001 — Phase 1 architecture, risks and open decisions

- Date: 2026-10-13
- Status: **Accepted** 2026-10-14 (owner approved the recommended option A for decisions 1–5)
- Context: empty workspace except the original PLAN.md. Target: Node 22, Express 4.22.x, CommonJS, Jest 30 + Supertest 7.

The full design is in ARCHITECTURE.md. This record captures the reasoning, the main risks, and the five choices that need the owner's call.

## Technical risks (ranked)

1. **Nested-router route templates can leak concrete IDs.** Express 4 exposes the leaf pattern (`req.route.path`) but only the *concrete* mount prefix (`req.baseUrl`). Logging `baseUrl + route.path` is the common mistake and would violate the privacy contract. Mitigation: never emit `baseUrl`; use explicit mount templates or `null` (decision 2).
2. **Headers after flush.** Any attempt to set `Server-Timing` after `writeHead` throws `ERR_HTTP_HEADERS_SENT`. Mitigation: `on-headers` hook on `writeHead` + `headersSent` guards everywhere; tests for streaming and early flush.
3. **Mis-classifying `close`.** Modern Node emits `close` after every response, so "close = abort" produces false interruption logs. Mitigation: classify by `res.writableFinished`; tests with a real socket.
4. **Express 4 async error gap.** Rejected promises in `async` handlers bypass Express 4; the request hangs and may never terminate, so no log is produced. This is a platform limitation we document rather than hide.
5. **Sink misbehaviour.** A sink that throws, rejects, or blocks (sync file writes, slow transport) can affect latency or spam stderr. Mitigation: catch sync throws, attach `.catch` to promises, rate-limit error reporting, no buffering/retry. We cannot protect against a sink that blocks the event loop; documented.
6. **Default `statusCode = 200`.** Node initializes `res.statusCode` to 200; logging it for an interrupted request would fabricate successes. Mitigation: `status: null` unless `headersSent`.
7. **Header/log injection via client-provided IDs.** Mitigation: strict charset and length validation; invalid input replaced, never rejected with an error.

## Dependency decision (summary)

Runtime: `on-headers ^1.1.0` and `on-finished ^2.4.1`. Rationale in ARCHITECTURE.md section 5. Both are jshttp packages; `on-finished` is already a transitive dependency of Express 4 so it adds nothing to the install. This revises the original PLAN.md principle of "zero mandatory dependencies" (decision 1).

## Implementation sequence

| Phase | Deliverable | Done when |
|---|---|---|
| 2 | request-id.js, server-timing.js, index.js (without logging), tests | ID and header tests green, including streaming early-flush and 1000-concurrent uniqueness |
| 3 | logger.js, route-template.js, on-finished wiring, tests | One record per request across normal / `next(err)` / 404 / real-socket abort; privacy scan green; sink failure isolated |
| 4 | demo/app.js, README | Demo runs with `node demo/app.js`, no external services; README covers options, schema, privacy, limitations |
| 5 | bench/ + results | 3+ runs per variant, raw JSON kept with environment metadata, caveated summary |

## Acceptance criteria for v0.1

- `X-Request-Id` present on every response; `req.id` is a valid string in handlers; invalid/oversized/injection-attempt incoming IDs never crash or 4xx and are replaced.
- `Server-Timing` is set before headers are flushed for normal, error and streaming responses; never thrown `ERR_HTTP_HEADERS_SENT`; unfinished timers omitted; `maxEntries` enforced.
- Exactly one log record per request for: 200, `next(err)` 500, unmatched 404, matched-handler 404, client abort before headers, client abort mid-stream.
- `status` is `null` when headers were never sent; `termination` is `"interrupted"` only when `close` arrived without `finish`.
- `route` is a template or `null`; a test asserts no concrete path segment from a parameterized request ever appears anywhere in the serialized record.
- A record never contains: query string, body, header values, cookies, IP, authorization token, error message or stack (asserted by a leakage test with planted sentinel values).
- A sink that throws or rejects does not change the HTTP response and does not stop subsequent records.
- No runtime dependency other than `on-headers` and `on-finished`.

## Open decisions (owner's call)

### Decision 1 — Accept two runtime dependencies?

- **Option A (recommended):** `on-headers` + `on-finished`. Battle-tested `writeHead` interception; `on-headers` 1.1.0 carries the CVE-2025-7339 fix; `on-finished` already ships with Express 4.
- **Option B:** zero runtime deps. Implement a `writeHead` patch and a `finish`/`close` listener ourselves (~40 lines total). Feasible on Node 22 only, but we then own the edge cases and the security surface.
- Impact: changes the "sıfır zorunlu bağımlılık" principle in PLAN.md.

### Decision 2 — Nested routers: safe default vs. accurate patching?

- **Option A (recommended):** no patching. Leaf `req.route.path` when there is no mount prefix; with a prefix, match `req.baseUrl` against user-supplied `route.mounts` templates, otherwise `null`. Explicit `route.resolver` / `res.locals.observeRoute` always wins.
- **Option B:** OpenTelemetry-style patching of `Router`/`Layer.handle` to accumulate mount patterns automatically. Accurate for any nesting depth, but invasive, Express-version-sensitive, and harder to reason about.
- Impact: Option A means apps with `app.use('/tenants/:tenantId', router)` get `route: null` until they configure `mounts`. Option B could be a v0.2 opt-in.

### Decision 3 — Default for `requestId.trustIncoming`?

- **Option A (recommended):** `false`. Safe by default; nothing from the network is echoed until the operator opts in. The React Native correlation demo would set it to `true` explicitly.
- **Option B:** `true` (accept if valid). Matches the original PLAN.md and makes proxy/mobile correlation work out of the box, but any client can then choose the ID that appears in your logs.
- Either way, the record carries `requestIdSource` so consumers can tell generated from client IDs.

### Decision 4 — Demo scope: minimal vs. docker-compose?

- **Option A (recommended):** `demo/app.js` only, with simulated slow/failing/streaming/nested endpoints via `setTimeout`. Runs with `node demo/app.js`, no Docker, no Mongo/Redis/faker. Matches "testable without external infrastructure".
- **Option B:** original PLAN.md demo: docker-compose with MongoDB + Redis + seeded data to show behaviour when dependencies fail.
- Impact: Option B is more impressive but is a separate project in itself; it can come after v0.1 as `demo-stack/`.
- Refined by ADR-0002: if Option A is chosen, the demo takes the `diagnostic-lab` shape (scenarios L0, L1, L2, L7, L8 in v0.1).

### Decision 5 — Ship the opt-in `log.extend(req, res)` hook in v0.1?

- **Option A (recommended):** yes. Small (shallow merge, wrapped in try/catch), and it is the only sanctioned way for users to add fields such as a tenant or user id. Without it, people fork or wrap the sink and lose the schema.
- **Option B:** defer to v0.2 and keep the v0.1 record fixed.
- Related contract details already assumed (say if you disagree): `termination: "finished" | "interrupted"` replaces PLAN.md's `aborted: true`; existing `req.id` is kept, not overwritten; `service`/`release` default to `null` with no env-var fallback; an error-tagging helper middleware (`errorName` without message) is deferred to v0.2.

## Consequences

Once accepted: PLAN.md and ARCHITECTURE.md are the contract; tests in Phase 2/3 are written against the acceptance criteria above; any later deviation gets its own ADR.

## Outcome (2026-10-14)

1. Runtime deps `on-headers` + `on-finished`: accepted.
2. Nested routers: no patching; leaf route, `route.mounts` templates, explicit resolver, else `null`: accepted.
3. `requestId.trustIncoming` defaults to `false`: accepted.
4. Minimal in-process demo (diagnostic-lab shape per ADR-0002): accepted.
5. `log.extend(req, res)` opt-in hook ships in v0.1: accepted.
