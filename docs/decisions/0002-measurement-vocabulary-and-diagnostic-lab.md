# ADR-0002 — Measurement vocabulary, `headerDurationMs`, and the diagnostic-lab demo

- Date: 2026-10-13
- Status: **Accepted** 2026-10-14 (owner approved the recommended answer for decisions 1–3)
- Supersedes/refines: ADR-0001 decision 4 (demo scope). Decisions 1, 2, 3, 5 of ADR-0001 are unchanged.
- Source: the owner's product-performance research notes (kept outside this repository; nothing from any employer system was used).

## Context

The research notes make one point that changes the package contract: the most common mistake when reading access logs is treating a single duration as "how slow the server was". The same total time can come from a slow phase before the first byte, from a long body, from client-side work, or from several retries of one user action. A server middleware can only see some of these, and it should make the ones it does see distinguishable, and say "unknown" about the rest.

## Decisions

### A. Add `headerDurationMs` to the log record (contract change)

The record gains `headerDurationMs` (entry -> `writeHead`, `null` if headers never sent). It is the same measurement as the `app` entry in `Server-Timing`, so there is no new clock or hook; it is just also written to the log. Rationale: without it, the "late headers" and "slow body" cases are indistinguishable in logs, which is exactly the confusion the project exists to remove.

### B. Fix the vocabulary (ARCHITECTURE.md section 9)

`headerDurationMs`, `durationMs`, `termination` are server facts. `clientAttemptMs` and `operationMs` are reserved names for client-side measurements and are **not** produced by the middleware. The README and demo use these names and never call a difference between client and server numbers "network time".

### C. Shape the demo as a diagnostic lab (ARCHITECTURE.md section 10)

`demo/app.js` reproduces one symptom through several bounded, allowlisted mechanisms (L0, L1, L2, L7, L8 in v0.1; L3–L6 later). Success is judged on two things: correct records, and the docs/demo refusing to conclude what the data cannot support. This replaces the original docker-compose demo idea for v0.1 and makes ADR-0001 decision 4 option A concrete.

### D. Record keeping for experiments and benchmarks

Every benchmark or demo run that is kept writes a manifest next to its raw output using `bench/results/MANIFEST_TEMPLATE.md` (run id, scenario, commit, Node/Express/package versions, OS, hardware, load config, sink destination, repetitions, changed variable, correctness result, known blind spots). Reports follow: observation -> evidence -> alternative explanation -> missing data -> smallest next experiment. p95 values are never averaged across runs.

## Open decisions (owner's call)

1. **Accept `headerDurationMs` in the v0.1 record?** Recommended: yes. Cost is one field; it is the most useful number the package can add. Alternative: leave it only in `Server-Timing`.
2. **Which demo scenarios are required before v0.1 is called done?** Recommended: L0, L1, L2, L7, L8 (server-only, no client). L3–L6 and the small client are a second wave.
3. **Should the research notes file (`TUM_ARASTIRMA.md`) stay in this repository?** It names a real third-party application and store listings. Recommended: keep it out of the public repo (move to a private notes folder, or add it to `.gitignore`), and keep only the project-relevant conclusions, which are now in ARCHITECTURE.md sections 9–10 and this ADR.

## Consequences

- ARCHITECTURE.md sections 4.4, 9 and 10 updated; PLAN.md and TODO.md updated.
- Phase 3 tests gain an assertion that `headerDurationMs <= durationMs` for finished responses and is `null` when headers were never sent.
- The future `analyze` CLI must take only the log file as input; it never receives the scenario label as a hidden hint.

## Outcome (2026-10-14)

1. `headerDurationMs` is part of the v0.1 record: accepted.
2. v0.1 demo requires L0, L1, L2, L7, L8: accepted.
3. The owner's research notes stay out of version control: `TUM_ARASTIRMA.md` is listed in `.gitignore`. The file itself was not moved or deleted.
