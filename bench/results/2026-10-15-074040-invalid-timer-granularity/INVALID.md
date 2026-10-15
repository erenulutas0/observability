# Invalid run: kept as a record, do not use the numbers

This run used a first version of `--handler=work`, which waited `setTimeout(..., 2)` before responding.

On this Windows machine an idle Node.js timer fires only about every 15.6 ms. A measured `setTimeout(2)` averaged 15.56 ms. As a result:
- The baseline's p50 was about 15.5 ms instead of about 2 ms.
- Variants that did more work per request kept the event loop busier, so their timers fired sooner.
- Adding middleware therefore *increased* throughput, which is impossible for real overhead.

The handler was replaced by fixed CPU work (`bench/server.js`). The valid run with that handler is the next `2026-10-15-*` folder.
