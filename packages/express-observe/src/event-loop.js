'use strict'

// Event-loop delay sampler for the optional `eventLoopDelayMs` record field (ADR-0009).
//
// One interval timer measures how late each tick fires. Samples go into a fixed ring buffer; a request asks for
// the largest lateness seen since shortly before it entered the middleware. The timer is unref()ed, so it never
// keeps the process alive.

const CAPACITY = 256

function nowMs () {
  return Number(process.hrtime.bigint()) / 1e6
}

/**
 * @param {{ resolutionMs: number }} options
 */
function createEventLoopSampler ({ resolutionMs }) {
  const times = new Float64Array(CAPACITY)
  const lags = new Float64Array(CAPACITY)
  let head = 0
  let count = 0
  let timer = null
  let expected = 0

  function tick () {
    const t = nowMs()
    const lag = t - expected
    expected = t + resolutionMs
    times[head] = t
    lags[head] = lag > 0 ? lag : 0
    head = (head + 1) % CAPACITY
    if (count < CAPACITY) count++
  }

  /** Start sampling; safe to call more than once. */
  function start () {
    if (timer !== null) return
    expected = nowMs() + resolutionMs
    timer = setInterval(tick, resolutionMs)
    timer.unref()
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

  return { start, maxSince, stop, resolutionMs }
}

module.exports = { createEventLoopSampler, nowMs }
