'use strict'

// Event-loop delay sampler for the optional `eventLoopDelayMs` record field (ADR-0009).
//
// One interval timer measures how late each tick fires. Samples go into a fixed ring buffer; a request asks for
// the largest lateness seen since shortly before it entered the middleware. The timer is unref()ed, so it never
// keeps the process alive.
//
// The timer stops when no request is in flight and none has started for `idleStopMs` (ADR-0009, 2026-10-17
// addendum): waking a process every 20 ms costs about 0.8% of a core even with no traffic. The next request starts
// it again with an empty buffer, so that request reports null ("no measurement"), not 0.

const CAPACITY = 256

function nowMs () {
  return Number(process.hrtime.bigint()) / 1e6
}

/**
 * @param {{ resolutionMs: number, idleStopMs?: number }} options idleStopMs 0 keeps the timer running for good
 */
function createEventLoopSampler ({ resolutionMs, idleStopMs = 0 }) {
  const times = new Float64Array(CAPACITY)
  const lags = new Float64Array(CAPACITY)
  let head = 0
  let count = 0
  let timer = null
  let expected = 0
  let active = 0
  let lastStartAt = 0

  function tick () {
    const t = nowMs()
    const lag = t - expected
    expected = t + resolutionMs
    times[head] = t
    lags[head] = lag > 0 ? lag : 0
    head = (head + 1) % CAPACITY
    if (count < CAPACITY) count++
    if (idleStopMs > 0 && active === 0 && t - lastStartAt >= idleStopMs) stop()
  }

  /**
   * A request entered the middleware: start sampling if the timer is not running. Every start() must be followed
   * by one release() when that request ends, so the sampler knows whether anything is in flight.
   */
  function start () {
    active++
    lastStartAt = nowMs()
    if (timer !== null) return
    head = 0
    count = 0
    expected = lastStartAt + resolutionMs
    timer = setInterval(tick, resolutionMs)
    timer.unref()
  }

  /** The request that called start() has ended. */
  function release () {
    if (active > 0) active--
  }

  /**
   * Largest lateness observed at or after `fromMs` (monotonic milliseconds), including the lateness of the tick
   * that is overdue right now.
   *
   * Returns null when there is nothing to base a value on: the sampler is not running, or it has not completed a
   * single tick yet and no tick is overdue (typically the first request after start-up). "No data" must not read
   * as "no delay". Once the sampler has a baseline, 0 means no delay above the timer's granularity was seen.
   *
   * The overdue tick matters: after a block, the requests that waited are often handled before the sampler's
   * next tick runs, so the sample that would show the block does not exist yet when their record is built.
   * `now - expected` is how long the event loop has been busy since that tick was due.
   * @param {number} fromMs
   * @returns {number | null}
   */
  function maxSince (fromMs) {
    if (timer === null) return null
    let max = nowMs() - expected
    if (count === 0 && max <= 0) return null
    if (max < 0) max = 0
    for (let i = 1; i <= count; i++) {
      const index = (head - i + CAPACITY) % CAPACITY
      if (times[index] < fromMs) break
      if (lags[index] > max) max = lags[index]
    }
    return max
  }

  function stop () {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  return { start, release, maxSince, stop, resolutionMs }
}

module.exports = { createEventLoopSampler, nowMs }
