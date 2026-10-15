# ADR-0004 — `express-observe analyze`: a local log analysis CLI

- Date: 2026-10-14
- Status: **Accepted for implementation** (owner asked to start the analyze CLI; details below are open to review before merge)

## Context

The middleware writes one JSON record per request. Without a dashboard, the first question a developer asks of those lines is "which routes are slow or failing, and how slow?" The roadmap (PLAN.md) lists a local CLI for that as the first follow-up after v0.1. ADR-0002 adds a constraint: the tool sees only the log, and must say "unknown" where the log cannot support a conclusion.

## Decisions

1. **Same package, `bin` entry.** `npx express-observe analyze <file...>`. No new package and no runtime dependency: Node's `readline` and `util.parseArgs` are enough. The middleware's `require('express-observe')` API is unchanged.
2. **Input.** One or more files, or `-` for stdin. JSON lines. A line is a record only if it parses as a JSON object with `schemaVersion: 1` and valid core fields. Records wrapped by a logger that adds its own top-level fields (pino's `level`, `time`, ...) are accepted. Everything else is skipped and **counted by reason**: not JSON, not a record, unsupported schema version, invalid fields, outside the time window, too long (over 64 KiB).
3. **Grouping.** Default `METHOD route`. `--by route|service|release` for the other views. A `null` route is its own group, `(unknown route)`.
4. **Metrics per group.** Count; finished and interrupted; status classes including "no status"; 5xx rate; p50/p95/p99/max of `durationMs` and p50/p95/p99 of `headerDurationMs`.
   - Latency percentiles use **finished** records only. An interrupted record's duration measures time until the connection ended, which is a different quantity.
   - Nearest-rank percentiles on exact values (same method as the benchmark).
   - **Minimum samples:** p95 needs at least 20 values, p99 at least 100. Below that the value is `null` (shown as `-`), because a p99 from 12 requests is just the maximum.
5. **Honesty notes.** The report ends with notes derived only from the data: unknown routes present, interruptions present (and what they do not mean), mixed services or releases when not grouped by them, percentiles withheld for small groups, and the standing limits (server time only, in-flight requests absent).
6. **Output.** A plain-text table by default, `--json` for machines. `--sort count|p95|p99|errors|interrupted`, `--top N` (default 20, `0` for all), `--since`/`--until` (ISO 8601), `--slowest N` (up to 100) to list the slowest finished requests with their request IDs, so an outlier can be looked up.
7. **Terminal safety.** Every string taken from a log and printed in the table is reduced to printable ASCII. A log line must not be able to inject terminal escape sequences.
8. **Exit codes.** 0 report printed; 1 unreadable input or no valid records; 2 usage error.

## Consequences

- Memory grows with the number of records (two numbers per finished request). Fine for local files of a few million lines; a bounded histogram mode is a possible later change if needed.
- The CLI becomes part of the public surface: its options, JSON report shape (`reportVersion: 1`) and exit codes are versioned with the package.
- `express-observe doctor` and any other subcommands can reuse the same `bin` dispatcher.

## Addendum (2026-10-15): coverage, method and data quality

An external review of the project summary (item P2) asked that analyze never present retained logs as all traffic. It also asked for a statement of the quantile method and for checks against misleading input. The changes are additive; `reportVersion` stays 1.

- **Coverage.**
  - Every report ends with a note that it describes the records in its input only. It cannot know about sampling, filtering or loss before the input.
  - The text header has a `scope:` line saying the same.
  - A test uses the review's arithmetic counter-example. Keeping all 100 errors and 90 of 900 successes reports a 52.6% error rate where the true rate is 10%. The test fixes that analyze reports what is in the file and says it cannot correct for it.
- **Method.** `--json` has `method: { quantiles: 'nearest-rank', minSamples: { p95: 20, p99: 100 }, latency: 'finished-only' }`. The text output states the same under the table.
- **Interrupted requests.** They were already excluded from latency. The note now also says a group with many interrupted requests can look faster than its clients experienced it.
- **Data quality.**
  - `input.lastLineIncomplete` is true when the last non-empty line is not JSON, which typically means a log cut mid-write. It comes with a note.
  - `input.suspectUtf16` is true when skipped lines contain NUL characters. It comes with a note, and a hint in the "no records" error.
  - Unsupported `schemaVersion` and malformed records get their own notes.
  - A UTF-8 byte order mark was already accepted; it is now tested.
- **Not done.** Detecting duplicate request IDs would need memory per record. Weighted quantiles for known sampling rates and baseline–candidate comparison stay out of scope until there is a real need.
- Six new mutations in `tools/mutation/specs/analyze.js`, all caught.
