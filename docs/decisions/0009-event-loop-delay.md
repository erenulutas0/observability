# ADR-0009 — Optional event-loop delay in the access-log record

- Date: 2026-10-14
- Status: **Accepted** (owner approved the contract change; opt-in, additive field)

## Context

diagnostic-lab L3 showed the largest blind spot found so far: when synchronous work blocks the event loop, requests that arrive meanwhile wait **before** `observe()` runs. Their records say about 0.3 ms while their clients waited about 70 ms. Nothing in the record hints at it.

A middleware cannot measure that wait per request. Node does not expose when a request reached the kernel; the clock starts when JavaScript first sees the request, which is after the block. What can be measured is whether the process's event loop was blocked around a request.

## Decision

1. **Option** `eventLoop: { enabled: false, resolutionMs: 20 }`. Off by default, so the default record and cost do not change.
2. **Sampler.** When enabled, one interval timer per `observe()` instance, created on the first request and `unref()`ed so it never keeps the process alive. Each tick records how late it fired (lateness = actual time − expected time) in a fixed ring buffer of 256 samples. No per-request timer.
3. **Record field** `eventLoopDelayMs`, present only when enabled, placed after `durationMs`: the largest of
   - the lateness of every sample taken from one resolution interval before the request entered the middleware until the request ended, and
   - the lateness of the tick that is overdue right now (`now − expected`), computed synchronously when the record is built.

   Both are needed, and each is covered by a test that fails without it. When the block runs inside a timer, the waiting requests are handled before the sampler's next tick, so only the overdue tick shows the block. When the block runs in `setImmediate`, the sampler's tick runs (timers phase) just before the waiting requests are handled (poll phase), so only the look-back finds that sample. The first design assumed the second order always held; a real-socket test disproved it.
4. **Meaning, stated narrowly.** It says the *process* was blocked for about that long around this request. It does not say this request waited that long, and it cannot say which code blocked. Values below the platform's timer granularity are noise: on Windows timers are coarse (about 15 ms), so readings under about 20 ms carry no information there.
5. **analyze** aggregates the field when present (p95 and max per group) and adds a note when requests saw 50 ms or more. Records without the field are unaffected; `schemaVersion` stays 1 because the change is additive and opt-in.

## Alternatives rejected

- `perf_hooks.monitorEventLoopDelay`: precise, but it is a process-wide histogram that cannot be read for a time window per request without resetting it for everyone.
- Per-request timers: one timer per request costs more than the field is worth, and still cannot see the wait before the request was handled.
- Reporting it as part of `durationMs`: would turn a measured duration into an estimate.

## Consequences

- The record shape changes only for applications that enable the option. Consumers must treat the field as optional.
- One extra timer callback every `resolutionMs` per middleware instance when enabled.
- diagnostic-lab enables it, so L3 can show the field next to the gap it explains.

## Addendum (2026-10-14): `null` when there is no measurement

An external review of the project summary asked that "no sample" not be reported as `0`. The first request after start-up started the sampler, finished before the first tick, and was logged with `eventLoopDelayMs: 0`, which reads as "no delay" although a block before the sampler started is invisible.

- The field is now `number | null`. It is `null` when the sampler is not running, or has not completed a tick yet and no tick is overdue. Once the sampler has a baseline, `0` means no delay above timer granularity was seen.
- `schemaVersion` stays 1: the field is opt-in and the only change is that one value can now be `null`, which `analyze` already accepted.
- Test: "is null, not 0, before the sampler has any measurement" (1 s interval, so no tick can complete during the request). Removing the rule makes it fail.
- The README now states the method (own interval sampler, not `monitorEventLoopDelay`), the window, the aggregation (maximum), the ring buffer of 256 samples with no reset, and the sentence the review proposed.

## Addendum (2026-10-17): measured cost of the sampler

The Consequences above said "one extra timer callback every `resolutionMs`". [A trial on a real application](../trials/2026-10-17-conduit-nasa.md) measured what that costs on Windows 11:

- **Idle:** about 0.75% of one core at 20 ms and 0.2% at 100 ms. A bare `setInterval` of the same period accounts for most of it, about 0.5%.
- **Under load:** the CPU profiles showed about 7.5 s more "(program)" time per six-minute replay. It disappeared when only `eventLoop` was disabled.

The cost depends on time, not on the number of requests. The README now states it. Changing the default resolution, or switching to `monitorEventLoopDelay`, is a separate decision and needs a detection-quality check: L3's 80 ms block must still be seen.
