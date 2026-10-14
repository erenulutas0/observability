# ADR-0005 — `express-observe doctor`: black-box integration check with strict boundaries

- Date: 2026-10-14
- Status: **Accepted for implementation** (owner asked to start `doctor`; boundaries below are open to review before merge)

## Context

Most integration mistakes are invisible in a code review and obvious in one request: `observe()` registered after a middleware that already answered, a router mount missing from `route.mounts`, the same record written twice by two sinks, another logger writing the query string into the same file, a proxy cache replaying the same `X-Request-Id`. PLAN.md asks for a command that finds these with synthetic requests, and says the limits of touching a server must be designed first.

## Decision: black box, not in-process

`doctor` sends a few HTTP requests to a server that is already running and, optionally, reads the log file that server writes. It does **not** load the application's code.

Rejected alternative: importing the user's app module and inspecting `app._router.stack`. It would find mount problems without any request, but it executes arbitrary application code (database connections, listeners, side effects at import time) and depends on Express internals that differ between Express 4 and 5.

## Security boundaries

1. **Loopback only by default.** Targets must resolve by name to `localhost`, `127.0.0.0/8` or `::1`. Any other host is refused before a connection is made, unless `--allow-remote` is given. Even then, doctor is meant for the user's own development or staging servers.
2. **Safe methods only.** Every probe is a `GET`. No request body, no cookies, no `Authorization`, no credentials of any kind. Redirects are not followed.
3. **The user chooses the paths.** Doctor probes `/` by default, or up to 10 paths given with `--path`. It cannot know what a `GET` handler does; the help text says to pass only paths that are safe to request repeatedly.
4. **Bounded load and time.** At most 2 probes per path, plus one client-ID probe and one not-found probe: never more than 22 requests. Sequential, never concurrent. Each request has a **hard deadline** (`--timeout`, default 5 s, 1–30 s) for the whole exchange, not an idle timeout, so a server that trickles bytes cannot hold doctor open. Response bodies are discarded after 64 KiB. A probe whose headers arrived but whose body was cut short still counts as answered and is marked `bodyTruncated`.
   - Found during implementation: the first version used Node's socket idle timeout, which never fires while a server keeps sending a byte every 100 ms. A test now covers both the trickle and the endless-stream case.
5. **Recognisable.** Every probe sends `User-Agent: express-observe-doctor/<version>`, so the probes can be identified and filtered in logs.
6. **Random markers, not secrets.** Each run creates random marker values used in a query parameter (`express_observe_doctor`) and a header (`X-Express-Observe-Doctor`). They let doctor detect whether something logs query strings or headers. They carry no meaning.
7. **Read-only on the log.** `--log <file>` is only read. Doctor prints request IDs, statuses, route labels and its own findings; it never prints log lines. Text taken from responses or logs is reduced to printable ASCII before printing.

## Checks

| ID | Needs `--log` | Fails when | Warns when |
|---|---|---|---|
| `reachable` | no | a probe gets no HTTP response | |
| `request-id-header` | no | a response has no valid `X-Request-Id` (likely: `observe()` not on that path, or registered after a middleware that answered) | |
| `request-id-unique` | no | two probes get the same ID (a cache or another middleware is replaying it) | |
| `client-id-policy` | no | | (info only) whether a client-supplied ID was accepted |
| `server-timing` | no | the header is malformed | it is missing or has no `app` entry |
| `not-found-path` | no | the unmatched-path probe has no `X-Request-Id` | |
| `log-record-count` | yes | a probe's request ID appears 0 times (not logged, or not yet flushed) or more than once (double logging) | |
| `route-label` | yes | the unmatched-path record's route contains the probe's random path (raw URL logged) | a successful probe has route `null` (missing `route.mounts` entry, or a middleware response) or a route equal to a concrete path with ID-like segments |
| `privacy-markers` | yes | a marker value appears anywhere in the log file | |

Exit codes: 0 no failures (warnings allowed), 1 at least one failure, 2 usage error or refused target.

## Consequences

- Doctor's own requests appear in the application's logs and metrics. They are few, identifiable by user agent, and grouped under the probed routes plus one unmatched path.
- Checks that need the log only work when the log is a local file the user can point at. A server that ships logs elsewhere can still run the header checks.
- Writing the log may lag behind the response (buffered sinks). Doctor waits `--wait` ms (default 500) before reading it and says so when records are missing.
