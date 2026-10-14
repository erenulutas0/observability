# ADR-0008 — Support Express 5 alongside Express 4

- Date: 2026-10-14
- Status: **Accepted** (verified by running the full test suite on both versions)

## Context

The package targeted Express 4 only (ADR-0001). Express 5 is now the `latest` npm tag (5.3.0; 4.x continues as `latest-4`), and new applications start on it. ARCHITECTURE.md section 7 listed the expected differences: path-to-regexp v8 route syntax, and rejected promises from `async` handlers reaching `next(err)`.

## Decision

1. **Peer range `^4.17.0 || ^5.0.0`.** No code change was needed in the middleware itself.
2. **One test suite, two runs.** `express5` is a dev dependency aliasing `express@5.3.0`. `jest.express5.config.js` maps `require('express')` and `express/package.json` to it, so every test file runs unchanged against Express 5. The package's `npm test` runs both; `test:express4` and `test:express5` run one each.
3. **A guard test** (`test/express-version.test.js`) checks that each run loads the Express major it is meant to cover, so a broken mapping cannot silently turn the Express 5 run into a second Express 4 run. This mattered: the first probe read `express/package.json`, which was not mapped yet, and reported 4.22.3 while the routes were in fact handled by Express 5.
4. **Version-specific behaviour gets version-specific tests:**
   - Route syntax: Express 4 inline regex parameters (`:name(\w+)`) only on 4; Express 5 named wildcards (`/*splat`) and optional segments (`{.:ext}`) only on 5. All are logged as written and never leak the matched values.
   - Rejected `async` handlers: on Express 5 a single finished 500 record; on Express 4 the request stays open and is logged as `interrupted` with `status: null` once the client gives up.

## Findings

- On the first Express 5 run, 205 of 206 tests passed; the one failure was Express 4-only route syntax in a test, not a middleware problem. Request IDs, Server-Timing, termination, route capture at match time (ADR-0003), nested routers, sub-apps, sinks, privacy, `analyze` and `doctor` behave the same.
- Express 5's default error handler, like Express 4's, prints the error stack to stderr outside `NODE_ENV=test` (checked with a small probe).
- While stabilising the matrix, a leak assertion failed once in about ten runs: the sentinel `77` appeared inside a timestamp (`…34.877Z`). Short numeric sentinels were replaced by 7-digit values across the route tests. No assertion was removed or loosened.

## Consequences

- `npm test` in the package takes about twice as long.
- The demo and benchmark workspaces still pin Express 4.22.3; they exercise the middleware, not Express-version behaviour.
- `route.mounts` still accepts only literal and `:param` segments, so routers mounted on Express 5 wildcard paths need an explicit label.
