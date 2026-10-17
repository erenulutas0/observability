# ADR-0011 — `analyze --by field:<name>`: grouping by a field added with `log.extend`

- Date: 2026-10-17
- Status: **Accepted** (owner approved in chat on 2026-10-17; additive CLI option, `reportVersion` stays 1)

## Context

A private database experiment, outside this repository, measured an endpoint whose cost grows with page depth: deep pages were several times slower than the first. express-observe deliberately does not log query strings. So page 1 and page 100 land in the same `GET /feed` group, and `analyze` shows only a wide p95/p99, not its cause.

An application can already add a coarse field with `log.extend`, for example `pageBucket: '1' | '2-10' | '11-100' | '>100'`. What is missing is a way for `analyze` to group by it.

## Decision

1. **Option.** `--by field:<name>`. `<name>` is a top-level record field name: letters, digits and `_`, starting with a letter or `_`, at most 64 characters. Core record fields are refused with exit code 2: they either have their own grouping or are unique per request.
2. **Key.** `METHOD route` plus `<name>=<value>`, so each endpoint is split by the field rather than different endpoints being mixed. A record without the field, or with `null`, gets `<name>=(not set)`. Value rules:
   - strings, numbers and booleans are used as text, truncated to 64 characters;
   - objects and arrays become `(not a scalar)`.
3. **Cardinality cap.** At most 50 distinct values of the field are kept across the whole input. Further values go into `<name>=(other values)`, and a note says the field looks high-cardinality, for example an ID. Memory stays bounded, and a report cannot become a list of user identifiers.
4. **Notes.** The report says how many records did not have the field. It reminds the reader that the field's values come from the application's own `log.extend`: privacy and correctness of those values are the application's responsibility.
5. **JSON.**
   - `groupBy` is `"field:<name>"`.
   - A new top-level `groupField` holds `{ name, distinctValues, capped, missing }`.
   - Other report shapes are unchanged, so `reportVersion` stays 1.

## Alternatives rejected

- **Group by the field alone.** It mixes endpoints whose cost has nothing to do with each other.
- **Log the raw page number or query string.** This breaks the privacy defaults, and the page number is unbounded.
- **A general expression language for grouping.** It is far larger than the need.

## Consequences

- One more accepted value for `--by`. Existing values behave as before.
- The README gains a recipe that shows `log.extend` with a bucketed value and `analyze --by field:pageBucket`.
