# Pilot runbook: trying express-observe on an application with real traffic

A step-by-step plan for a first, controlled pilot (TODO.md, review item P4). It is written for one Express application owned by whoever runs the pilot.

**What stays out of this repository.** Nothing from the pilot application comes back here: no logs, code, configuration, route names, hostnames or numbers that identify it. A problem found during the pilot comes back as an issue with a synthetic reproduction, in the style of `demo/` and `test/`.

## 0. Before you start

| Check | Why |
|---|---|
| Node.js 22 or later on every machine that runs the app | The package requires it. An older runtime is a blocker, not a warning. |
| Express 4.17+ or 5.x | Peer dependency range. |
| Where logs go today, and which logger writes them | The sink should feed that logger, not open a new channel. |
| Whether the app already sets or reads a request or correlation ID | Decides `requestId.header` and `onExistingId`. |
| How many processes serve traffic (single, cluster, several hosts) | `getDiagnostics()` is per process. |
| Whether responses reach the public internet directly | Decides whether `Server-Timing` should be sent. |
| Whether the app's handlers are `async` on Express 4 | A rejected promise exits the process under Node 22 defaults (see README, Known limitations). This is independent of this package, but the pilot is a good moment to check it. |

## 1. Install a fixed build

The package is not published to npm. Install a packed tarball built from a tagged commit, so the pilot runs exactly one known version:

```bash
cd packages/express-observe
npm pack
```

Copy the resulting `express-observe-<version>.tgz` into the pilot project, commit it there or keep it in a local artifact store, then:

```bash
npm install ./express-observe-0.1.0-dev.0.tgz
```

Record the tag and commit of this repository that produced the tarball.

## 2. Configure

Start from this and change only what the checks in section 0 require:

```js
const observe = require('express-observe')

app.use(observe({
  service: 'my-app',                        // a short, non-secret name
  release: process.env.RELEASE ?? null,     // the deployed version, if you have one
  requestId: { trustIncoming: false },      // keep false unless a trusted proxy sets the header
  serverTiming: { enabled: false },         // public traffic: do not expose timings to clients at first
  route: { mounts: [] },                    // add the mount template of every router, e.g. '/api/v1'
  log: { sink: (record) => logger.info(record) },
}))
```

- **Register it first,** before body parsers, static files, auth and routers. Anything registered earlier is invisible to it.
- **Existing request IDs.** If an earlier middleware already sets `req.id`, `onExistingId: 'keep'` (the default) keeps it. If a proxy sends a correlation header you trust, set `requestId.header` to its name and `trustIncoming` to a function that checks the request really came through that proxy.
- **`Server-Timing`.** Leave it off for public traffic until you decide that clients may see server timings. Turn it on in staging, where it helps.
- **Do not add `log.extend` fields in the pilot.** The point is to see the default record first. If you need a field later, check that it contains no user identifiers.

Log the diagnostics counters once a minute:

```js
const { getDiagnostics } = require('express-observe')
setInterval(() => logger.info({ expressObserveDiagnostics: getDiagnostics() }), 60_000).unref()
```

## 3. Local check

Run the app locally with its log going to a file, then run doctor. Use PowerShell or cmd on Windows, see README:

```bash
npx express-observe doctor http://127.0.0.1:3000 --path / --path /api/some/real/route/123 --path /health --log app.log
```

- Pick 3–10 `GET` paths that are safe to call repeatedly and that cover each router.
- Fix every `FAIL`. `route-label` warnings usually mean a router mount is missing from `route.mounts`.
- Then run `npx express-observe analyze app.log` and check that every route you expect appears as a template, with no raw IDs.

## 4. Staging or a short low-risk window

If there is no staging environment, use the quietest time of day with the existing logging left in place.

Watch, for a few days:

| Signal | Expected | Act if |
|---|---|---|
| Response status codes and bodies | Unchanged | Anything differs: roll back, then reproduce it synthetically |
| `requests.inFlight` in the diagnostics line | Returns to about 0 when traffic is quiet | It keeps growing: requests never end, or the app holds connections open |
| `records.dropped` | 0 | Any value: there is a bug in this package, so open an issue |
| `records.sinkErrors`, `records.sinkPending` | 0, or briefly above 0 | They keep growing: the sink or logger is failing or stuck |
| `finished + interrupted` vs `emitted + dropped` | Equal once nothing is in flight | They differ while logging is enabled: this is a bug, so open an issue |
| `route: null` share in `analyze` | Low, and explained, e.g. 404s for unmatched URLs | It is high on paths you serve: fix `route.mounts` or label responses with `res.locals.observeRoute` |
| stderr lines starting with `express-observe:` | None | Any: read them. They name the failing part, never the data |
| Process CPU and p95 latency from your existing monitoring | No change you can separate from normal variation | A visible step: send a profile from `bench/profile.js` on a synthetic copy, not production data |

## 5. Production canary

Run it on one instance, or a small share of traffic, for one to two weeks. Keep the existing logging unchanged next to it.

- Compare record counts per hour with the request counts your existing logs or proxy report. A small gap is expected: in-flight requests, restarts and sink failures. Investigate a persistent gap.
- Run `analyze` on a day of records. Check that the result matches what you already know about the app's slow and busy routes. Pay attention to the notes: what they say the data cannot show is part of the result.

## 6. Roll back

Remove the `app.use(observe(...))` line and the diagnostics timer, then redeploy. The package installs no global handlers and keeps no state outside the process, so nothing else needs cleaning up.

## 7. What counts as success

- No change in responses, and no growth in CPU or latency beyond normal variation.
- Counters that agree with each other and with the existing request counts, as described in section 4.
- Route labels that need no hand-editing to read.
- At least one question about the app that the records answered better than the existing logs. If there is none, that is a finding too.

Write the outcome down in your own words, without data from the application. Add it to TODO.md under P4 with the package commit that was used.
