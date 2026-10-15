# Cost of getDiagnostics() counters — 2026-10-15

ADR-0010 adds counters to every request. With logging disabled, it also adds termination listeners to every request. These runs measured that cost before the commit.

**Setup**
- Machine: Windows 11, Intel i5-12500.
- Software: Node 22.23.2, Express 4.22.3.
- Background load: no VM or emulator was running. Other load was not controlled.
- Harness: `bench/micro.js`, in-process with single-threaded GC. It reports CPU µs per request with no I/O.
- Rounds: 12 rounds of 40,000 requests, with A and B alternating.
- A: branch `feat/types` (73b53b3), the commit before the change.
- B: the working tree with the counters.

| Run | Variant | Median paired difference, B − A | B lower in |
|---|---|---|---|
| Counters (`diagnostics-cost.txt`) | full-log (default path) | −0.03 µs (−0.03%) | 8 of 12 |
| Counters | ids-timing (`log.enabled: false`) | +2.35 µs (+4.2%) | 1 of 12 |
| A vs A (`noise-floor-a-vs-a.txt`) | full-log | −1.77 µs (−2.1%) | 8 of 12 |
| A vs A | ids-timing | +1.75 µs (+2.8%) | 3 of 12 |

**Default path, logging on.** No measurable change. The difference is smaller than the same-code noise. Counting adds a few integer increments to work the middleware already does.

**Logging off.** The counters cost more here, probably about 2 µs per request: B was slower in 11 of 12 rounds. The same-code run, however, moved 1.75 µs in the same direction in 9 of 12 rounds. So the cost cannot be separated from noise on this machine.

The direction matches the design. With logging off, each request now gets a `finish` and a `close` listener, which ADR-0007 measured at a few microseconds. This is the price of `requests.*` counters that work in every configuration. ADR-0010 records it.
