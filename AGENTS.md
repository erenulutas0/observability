# AGENTS.md — working rules for this repository

Durable instructions for any agent or contributor. Keep this file short; details live in ARCHITECTURE.md, TODO.md and docs/decisions/.

## Project

- `express-observe`: lightweight, privacy-first observability middleware for Express 4 on Node 22. CommonJS. MIT.
- Personal open-source project. Never reference, copy or adapt proprietary code, configs, logs or data from any employer or third party. Use synthetic fixtures only.
- Sources of truth: ARCHITECTURE.md (what is built and how), TODO.md (what is pending/done), docs/decisions/ (why). PLAN.md is the roadmap. Do not duplicate content across them; link instead.

## Workflow

- Work in the phases defined in PLAN.md. Finish the current phase's acceptance criteria before starting the next.
- Small, understandable changes. No unrelated refactors. Preserve existing user edits.
- Before changing an agreed contract (option names, log fields, header behaviour), explain the change and get approval; then record it in docs/decisions/.
- After each meaningful change: run the relevant tests, report pass/fail/not-run honestly, update ARCHITECTURE.md status markers and TODO.md.

## Code

- Node >= 22, Express 4.x peer. `"use strict"` CommonJS modules. No build step.
- Runtime dependencies are limited to `on-headers` and `on-finished` unless a decision record says otherwise.
- The middleware must never: throw into the request pipeline, call `next(err)` for its own failures, mutate headers after `res.headersSent`, or log bodies, URLs, query strings, headers, cookies, IPs, user identifiers, error messages or stack traces by default.
- Durations use `process.hrtime.bigint()`. IDs use `crypto.randomUUID()`.
- Public API surface is `observe(options)` plus `res.serverTiming`, `req.id`, and the documented record shape. Anything else is private.

## Tests

- Jest + Supertest in `packages/express-observe/test/`. Tests assert externally observable behaviour (headers, status, emitted records), not internals.
- Never weaken or delete a failing test to get green. If the contract must change, see Workflow above.
- Client-disconnect tests use a real `net`/`http` socket, not mocks.
- `npm run lab:check` (demo scenarios with assertions) must pass as well as `npm test`.

## Docs

- README documents install, options, record schema, privacy defaults and known limitations (Express 4 async errors, no delivery guarantees, route label rules).
- Benchmarks live in `bench/`, raw outputs in `bench/results/` with date, Node/Express version, OS, hardware and load config. No "zero overhead" claims.
