'use strict'

const SCHEMA_VERSION = 1
const DEFAULT_WARN_INTERVAL_MS = 10_000

/**
 * Rate-limited warning channel for the middleware's own problems (throwing user callbacks, failing sinks,
 * internal bugs). At most one line per interval; the number of suppressed warnings is reported on the next line.
 * Lines carry only an error class name and code, never an error message or stack, because those can contain
 * request data.
 *
 * @param {{ intervalMs?: number, write?: (line: string) => void, now?: () => number }} [options]
 * @returns {(context: string, err?: unknown) => void}
 */
function createWarn (options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_WARN_INTERVAL_MS
  const write = options.write ?? ((line) => process.stderr.write(line))
  const now = options.now ?? Date.now
  let lastAt = -Infinity
  let suppressed = 0

  return function warn (context, err) {
    try {
      const t = now()
      if (t - lastAt < intervalMs) {
        suppressed++
        return
      }
      lastAt = t
      const kind = errorKind(err)
      const extra = suppressed > 0 ? ` (${suppressed} similar warnings suppressed)` : ''
      suppressed = 0
      write(`express-observe: ${context}${kind ? ` [${kind}]` : ''}${extra}\n`)
    } catch {
      // a failing stderr must not affect requests
    }
  }
}

function errorKind (err) {
  if (err === undefined || err === null) return ''
  if (typeof err === 'object' || typeof err === 'function') {
    const name = typeof err.name === 'string' ? err.name : 'Error'
    const code = typeof err.code === 'string' ? `:${err.code}` : ''
    return `${name}${code}`.replace(/[^\x20-\x7E]/g, '').slice(0, 64)
  }
  return typeof err
}

function roundMs (ms) {
  return Math.round(ms * 1000) / 1000
}

/**
 * Build the access-log record. Field order is fixed so JSON lines are easy to scan.
 * Only the fields listed here exist; nothing is copied from req/res wholesale.
 */
function buildRecord (fields) {
  return {
    schemaVersion: SCHEMA_VERSION,
    timestamp: fields.timestamp,
    requestId: fields.requestId,
    requestIdSource: fields.requestIdSource,
    service: fields.service,
    release: fields.release,
    method: fields.method,
    route: fields.route,
    status: fields.status,
    headerDurationMs: fields.headerDurationMs === null ? null : roundMs(fields.headerDurationMs),
    durationMs: roundMs(fields.durationMs),
    termination: fields.termination
  }
}

/**
 * Shallow-merge the opt-in extension. Core fields always win so consumers can rely on the schema.
 * A throwing or non-object extension is ignored and the core record is still emitted.
 */
function applyExtension (record, extend, req, res, warn) {
  if (extend === null) return record
  let extra
  try {
    extra = extend(req, res)
  } catch (err) {
    warn('log.extend threw; record emitted without extension fields', err)
    return record
  }
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return record
  return Object.assign({}, extra, record)
}

function defaultSink (record) {
  process.stdout.write(JSON.stringify(record) + '\n')
}

/**
 * Wrap a sink so that neither a synchronous throw nor an asynchronous rejection escapes.
 * No buffering, no retry: a record that fails is reported and dropped.
 *
 * @param {{ sink: (record: object) => unknown, onSinkError: ((err: unknown, record: object) => void) | null, warn: Function }} options
 * @returns {(record: object) => void}
 */
function createDeliver ({ sink, onSinkError, warn }) {
  function reportFailure (err, record) {
    if (onSinkError === null) {
      warn('log sink failed; record dropped', err)
      return
    }
    try {
      onSinkError(err, record)
    } catch (handlerErr) {
      warn('log.onSinkError threw', handlerErr)
    }
  }

  return function deliver (record) {
    let result
    try {
      result = sink(record)
    } catch (err) {
      reportFailure(err, record)
      return
    }
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return
    try {
      if (typeof result.then === 'function') {
        result.then(undefined, (err) => reportFailure(err, record))
      }
    } catch (err) {
      reportFailure(err, record)
    }
  }
}

module.exports = {
  SCHEMA_VERSION,
  createWarn,
  buildRecord,
  applyExtension,
  defaultSink,
  createDeliver
}
