# Trial: express-observe in someone else's Express app, under a real arrival pattern

- Date: 2026-10-17
- Package: `main` at 2034dc5, installed from the packed tarball as [the pilot runbook](../pilot-runbook.md) describes
- Machine: Windows 11, i5-12500, Node 22.23.2, PostgreSQL 16 in Docker

This is not a pilot with real users; none was available. It is the closest substitute:
- an application this project did not write;
- request timing taken from a real web server's log;
- every result compared with the same run without the middleware.

The trial application, its database and the raw logs were kept outside this repository.

## Setup

- **Application.** [RealWorld "Conduit" backend](https://github.com/gothinkster/node-express-realworld-example-app), MIT licence, last commit 2024-01-04. Its stack:
  - Express 4.18, TypeScript and Prisma 4 with PostgreSQL;
  - JWT auth via `express-jwt`, password hashing with `bcryptjs`;
  - `express.static` for images, routers mounted under `/api`.
- **Arrival pattern.** [NASA-HTTP, July 1995](https://ita.ee.lbl.gov/html/contrib/NASA-HTTP.html), from the Internet Traffic Archive; the traces may be freely redistributed.
  - Only timestamps, status codes and the file type (image, page, other) were read. Hosts and URLs were not used.
  - The busiest two hours were taken: 27,935 requests on 1995-07-13, the day of a shuttle launch. They averaged 3.9 requests per second, with up to 18 in one second.
  - The window was replayed 20 times faster: six minutes, about 78 requests per second on average, open loop.
- **Mapping.** Each NASA request became one API call of a matching kind, chosen by a seeded PRNG so every run sent the same sequence:
  - images: static files;
  - 304s: conditional GETs;
  - 302s: an unauthenticated `GET /api/user`, which answers 401;
  - 404s: unmatched paths;
  - pages: API reads, including list pagination with an `offset`;
  - other: 70% reads, 30% writes (comments, favourites, new articles, logins).
  
  About 0.5% of reads gave up after 15 ms. Before each replay: a fresh database, 40 users and 80 articles.
- **Configuration.** First the README quick start. Then `route: { mounts: ['/api'] }` after doctor's advice, `eventLoop: { enabled: true }`, and `log.extend` adding a coarse `offsetBucket` for list requests.

## Results

### Integration

| Step | Result |
|---|---|
| Install from tarball, TypeScript `tsc --noEmit` with the app's own config | Compiles: default import with `esModuleInterop`, `@types/express` 4.17 |
| `doctor`, quick-start config | 0 failures, 1 warning: every `/api` route logged with `route: null`, with the correct advice (add the mount template) |
| `doctor`, after adding `route.mounts: ['/api']` | All checks pass. Records say `/api/articles/:slug` and `/api/profiles/:username`, not the slug or user name |

### Correctness under the replay (two runs with the middleware)

| Check | Result |
|---|---|
| Responses compared with the runs without middleware | Same status counts per operation. Differences are only in timing-dependent abandons (±3) and 3 `ECONNRESET`s in one run that did not recur |
| Records vs `getDiagnostics()` | `records == emitted`, `finished + interrupted == emitted + dropped`, `inFlight` back to 0, 0 dropped, 0 sink errors, 0 warnings, in both runs |
| Abandoned clients | 11 of 11 and 14 of 16 abandons logged as `interrupted` with `status: null`. The other two clients gave up after the server had already finished |
| Privacy | None of these appear in about 56,000 records: user names, e-mails, JWTs, passwords, comment text, `offset=`/`limit=`, the unmatched paths |

### What the records showed about the application

- **Event-loop blocking found without being told about it.** Even trivial routes had a p99 of about 70 ms; for example `GET /api/tags` had p50 3.6 ms and p99 69.7 ms. `analyze` noted that 1,298 records saw the event loop blocked for 50 ms or more, at most 132 ms.
  - The CPU profile names the cause: `bcryptjs`, a pure-JavaScript password hash, takes about 14 s of main-thread time for about 214 hashes, about 70 ms each.
  - `POST /api/users/login` has a p50 of 68 ms.
  - The records cannot say which code blocked, and they do not claim to; the profile confirmed it.
- **Static files dominate the unknown routes.** 15,157 of 28,054 records (54%) are `route: null`: images served by `express.static` and their 304s. This is the documented behaviour for responses from plain middleware, but in a real app it means half the log has no label unless the app labels static responses.
- **Field grouping works on real data.** `analyze --by field:offsetBucket` split `GET /api/articles` into `offsetBucket=0`, `1-50` and so on. It also lists every other route with `offsetBucket=(not set)`, which is noise for this question.

### Cost

Server CPU per request during the replay, with all threads, user and kernel, measured by Windows:

| Run | Without middleware | With express-observe (all options as above) |
|---|---|---|
| Round 1, alternating | 2,191 µs | 2,938 µs |
| Round 2, alternating | 2,256 µs | 2,799 µs |
| Profiled round A | 2,429 µs (user 1,104) | 3,021 µs (user 1,368) |
| Profiled round B | 2,818 µs (user 1,163) | 2,884 µs (user 1,275) |
| Profiled, `eventLoop` disabled | | 2,789 µs (user 1,187) |

- **Total process CPU is too noisy to resolve this.** Kernel time alone moved by 25% between two runs without the middleware, from 1,325 to 1,656 µs per request.
- **Own cost:** express-observe's own work is **about 115 µs per request.** That is about 6.7% of the main thread's busy time in every profiled run with the middleware. It counts samples whose nearest userland frame is express-observe or on-headers, including the stdout write of the default sink and excluding Node's own HTTP work.
  - Largest parts: the default sink about 28 µs, of which the stdout write is about 15 µs; building the record at termination about 13 µs; the event-loop sampler's clock reads about 11 µs.
- **The event-loop sampler costs more than expected, and by time, not per request.**
  - With `eventLoop` enabled, the profiles show about 7.5 s more "(program)" time per six-minute run: 9.1 s against 1.5 s.
  - With only `eventLoop` disabled, it goes back to 1.5 s, and user CPU comes back to the level of the runs without middleware.
  - Idle, with no requests at all, the measurements are:

| Idle process (30 s) | CPU |
|---|---|
| express-observe, `eventLoop` off | 0.00–0.05% of one core |
| express-observe, `eventLoop` on, 20 ms resolution | 0.73–0.78% of one core |
| a plain 20 ms `setInterval`, no express-observe | 0.47–0.57% |
| express-observe, `eventLoop` on, 100 ms resolution | 0.21% |
| a plain 100 ms `setInterval` | 0.05% |

  Most of it is the cost of waking a Windows process 50 times a second; the sampler's own work adds the rest. Linux was not measured.

## Conclusions

1. **It works on an application it was not written for.** Installation, types and doctor guided the one configuration change that was needed. Under a real arrival pattern the records were complete and consistent with the counters, and private values stayed out of the log.
2. **It found a real problem.** The 70 ms p99 on trivial routes came from password hashing blocking the event loop. Without `eventLoopDelayMs` the records would only have shown an unexplained tail.
3. **The event-loop option has a time-based cost that ADR-0009 and the README understated.** On this machine it is about 0.75% of one core when idle at the default 20 ms resolution, and more under load. It is opt-in, but the documentation must say this, and the default resolution deserves a decision.
4. **Static files need a recipe.** Half of a typical app's records can be unlabelled.

## Proposed follow-ups (not done in this change)

- **`eventLoop.resolutionMs` default 20 → 100, or `monitorEventLoopDelay` for sampling.** This is a contract change and needs approval and an ADR-0009 addendum. A new A/B is needed for detection quality at 100 ms: the L3 scenario's 80 ms block must still be seen.
- **README recipe for labelling `express.static` responses.** For example `res.locals.observeRoute` in a small middleware before `express.static`, or a `route.resolver`.
- **`analyze --by field:<name>`: option to hide groups where the field is not set.**
- **doctor text output:**
  - print a repeated warning once with a count;
  - say "13 distinct IDs (the client-ID probe is excluded)" instead of a bare 13.
