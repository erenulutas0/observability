# ADR-0003 — Capture the matched route and its mount prefix at match time

- Date: 2026-10-14
- Status: **Accepted** (implementation detail within ADR-0001 decision 2; the logged contract is unchanged)

## Context

ADR-0001 decision 2 chose "no patching of Express `Router`/`Layer`": labels come from `req.route.path`, mount templates in `route.mounts`, or `null`.

During Phase 3 a mislabel appeared on error paths. Express 4 assigns `req.route` in `Route#dispatch` and never clears it, but it restores `req.baseUrl` when control leaves a router through `next()` or `next(err)`. When a handler inside `app.use('/api', router)` calls `next(err)` and an app-level error handler responds, the termination callback sees `req.route.path === '/items/:itemId'` with `req.baseUrl === ''`, and would log `/items/:itemId` instead of `/api/items/:itemId`. Nothing leaks, but the label is wrong.

## Decision

At middleware entry, define a per-request accessor for `req.route` with `Object.defineProperty`. Its setter stores the assigned value and, at the same moment, a snapshot `{ path, baseUrl }`. Its getter returns the stored value, so every reader of `req.route` sees exactly what Express assigned.

- Scope: the single `req` object of one request. No prototype, `Router`, `Layer` or `Route` is modified.
- Fallback: if `req.route` cannot be redefined, both values are read at termination as before.
- `observe()` mounted after routing has already set `req.route` (for example inside a route) starts from that value.

## Consequences

- The nested `next(err)` case is labelled correctly; a test covers it, and reverting to read-at-termination makes that test fail.
- `req.route` becomes an accessor property on the request instance. Code that inspects property descriptors of `req` would notice; ordinary reads and writes behave the same.
- Express 5 still assigns `req.route` in route dispatch, so the approach should carry over; this is verified when Express 5 support is added.
