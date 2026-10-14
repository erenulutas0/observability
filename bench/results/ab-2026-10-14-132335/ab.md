# A/B ab-2026-10-14-132335

A = main (89a7e57), B = main (89a7e57) again. 6 rounds, alternating order, 50 connections, 10 s measured after 3 s warm-up, fresh server process per run.

| Variant | A µs CPU/req | B µs CPU/req | median paired diff | B lower in | A req/s | B req/s |
|---|---|---|---|---|---|---|
| ids-timing | 150.88 | 162.32 | 6.77 µs (4.49%) | 0 of 6 rounds | 6954.01 | 6212.19 |
| full-log | 236.58 | 240.14 | 4.77 µs (2.02%) | 1 of 6 rounds | 4609.65 | 4373.28 |

Server CPU per request is the primary metric. A difference counts only if B is lower in every round (or higher in every round) and the median difference is larger than the spread seen in an A-vs-A run (`--same`).

Correctness checks: all runs passed.

Environment: v22.23.2, Express 4.22.3, Windows_NT 10.0.26200 (win32 x64), 12th Gen Intel(R) Core(TM) i5-12500. Other load on the machine was not controlled.
