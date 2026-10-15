'use strict'

// Local diagnostics counters (ADR-0010). One set per process or worker thread (each worker loads its own copy of
// this module), shared by every observe() instance in it. Fixed counters only: no buffers, timers or handlers.

const DIAGNOSTICS_SCHEMA_VERSION = 1

const counters = {
  started: 0,
  finished: 0,
  interrupted: 0,
  emitted: 0,
  dropped: 0,
  sinkErrors: 0,
  sinkPending: 0,
  warnings: 0
}

const since = new Date().toISOString()
let threadId = null

/**
 * Snapshot of the counters for this process or worker thread. Returns a new object on every call.
 * Counters only increase (inFlight and sinkPending also decrease); take differences between snapshots.
 */
function getDiagnostics () {
  if (threadId === null) threadId = require('node:worker_threads').threadId
  const c = counters
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    pid: process.pid,
    threadId,
    since,
    requests: {
      started: c.started,
      finished: c.finished,
      interrupted: c.interrupted,
      inFlight: c.started - c.finished - c.interrupted
    },
    records: {
      emitted: c.emitted,
      dropped: c.dropped,
      sinkErrors: c.sinkErrors,
      sinkPending: c.sinkPending
    },
    warnings: c.warnings
  }
}

module.exports = { counters, getDiagnostics }
