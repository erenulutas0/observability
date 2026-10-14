'use strict'

/**
 * A sink that stores records in memory and lets tests wait until a given number has arrived.
 * Records are emitted on the server's 'finish'/'close', which can happen after the client already has the
 * response, so tests must wait rather than read synchronously.
 */
function collectingSink () {
  const records = []
  const waiters = []

  function sink (record) {
    records.push(record)
    for (const waiter of [...waiters]) {
      if (records.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        waiter.resolve(records.slice())
      }
    }
  }

  function waitFor (count, timeoutMs = 2000) {
    if (records.length >= count) return Promise.resolve(records.slice())
    return new Promise((resolve, reject) => {
      const waiter = {
        count,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          reject(new Error(`expected ${count} record(s), got ${records.length}`))
        }, timeoutMs)
      }
      waiters.push(waiter)
    })
  }

  /** Give late or duplicate emissions a chance to show up before asserting an exact count. */
  async function settle (ms = 100) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return records.slice()
  }

  return { sink, records, waitFor, settle }
}

const RECORD_KEYS = [
  'schemaVersion',
  'timestamp',
  'requestId',
  'requestIdSource',
  'service',
  'release',
  'method',
  'route',
  'status',
  'headerDurationMs',
  'durationMs',
  'termination'
]

module.exports = { collectingSink, RECORD_KEYS }
