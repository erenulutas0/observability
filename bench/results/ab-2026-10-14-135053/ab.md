# A/B ab-2026-10-14-135053

A = c1c10f7 (c1c10f7), B = working tree. 6 rounds, alternating order, 50 connections, 10 s measured after 3 s warm-up, fresh server process per run.

| Variant | A µs CPU/req | B µs CPU/req | median paired diff | B lower in | A req/s | B req/s |
|---|---|---|---|---|---|---|
| full-log | 236.21 | 200.99 | -38.26 µs (-16.2%) | 6 of 6 rounds | 4653.47 | 5522.6 |

Server CPU per request is the primary metric. A difference counts only if B is lower in every round (or higher in every round) and the median difference is larger than the spread seen in an A-vs-A run (`--same`).

Correctness checks: all runs passed.

Environment: v22.23.2, Express 4.22.3, Windows_NT 10.0.26200 (win32 x64), 12th Gen Intel(R) Core(TM) i5-12500. Other load on the machine was not controlled.
