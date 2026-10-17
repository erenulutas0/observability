'use strict'

const onHeaders = require('on-headers')
const { resolveRequestId } = require('./request-id')
const {
  nowNs,
  elapsedMs,
  createServerTiming,
  mergeHeaderValue,
  NOOP_SERVER_TIMING
} = require('./server-timing')
const {
  createWarn,
  buildRecord,
  applyExtension,
  defaultSink,
  createDeliver
} = require('./logger')
const { compileMounts, trackMatchedRoute, resolveRouteLabel } = require('./route-template')
const { createEventLoopSampler } = require('./event-loop')
const { counters, getDiagnostics } = require('./diagnostics')

// Per-response state lives under a symbol so it never collides with application properties.
const kState = Symbol('express-observe.state')

// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

const DEFAULT_REQUEST_ID_HEADER = 'X-Request-Id'
const DEFAULT_MAX_TIMING_ENTRIES = 16
const MAX_TIMING_ENTRIES_LIMIT = 64
const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 20
const DEFAULT_EVENT_LOOP_IDLE_STOP_MS = 10_000
const MAX_LABEL_LENGTH = 256

/**
 * Create the express-observe middleware.
 *
 * Invalid options throw here, at application startup. Nothing derived from a request ever throws.
 *
 * @param {object} [options] see ARCHITECTURE.md section 6
 * @returns {import('express').RequestHandler}
 */
function observe (options) {
  const config = normalizeOptions(options)
  const warn = createWarn()
  const deliver = config.log.enabled
    ? createDeliver({ sink: config.log.sink, onSinkError: config.log.onSinkError, warn })
    : null
  // Optional event-loop delay (ADR-0009): one unref()ed sampler per middleware instance, started on first use.
  const sampler = config.log.enabled && config.eventLoop.enabled
    ? createEventLoopSampler({ resolutionMs: config.eventLoop.resolutionMs, idleStopMs: config.eventLoop.idleStopMs })
    : null

  return function expressObserve (req, res, next) {
    // A second observe() instance on the same request is a no-op: one ID, one Server-Timing entry, one record.
    if (res[kState] !== undefined) return next()

    const state = {
      startedAt: nowNs(),
      headersAt: null,
      requestId: null,
      requestIdSource: null,
      finished: false,
      logged: false,
      sampling: false
    }

    try {
      res[kState] = state
      assignRequestId(req, res, state, config.requestId, warn)
      attachHeaderHook(res, state, config.serverTiming, warn)
      if (sampler !== null) {
        sampler.start()
        state.sampling = true
      }
    } catch (err) {
      warn('internal error while preparing request; continuing without full observation', err)
    }

    // Separate from the steps above so that the request is counted and its termination tracked even if one of
    // them failed (ADR-0010). The listeners fire asynchronously, so started is counted before any termination.
    try {
      attachTermination(req, res, state, config, warn, deliver, sampler)
      counters.started++
    } catch (err) {
      warn('internal error while tracking request termination', err)
    }

    next()
  }
}

function assignRequestId (req, res, state, policy, warn) {
  const { id, source } = resolveRequestId(req, policy, (err) => {
    warn('requestId.trustIncoming callback threw; incoming ID ignored', err)
  })

  state.requestId = id
  state.requestIdSource = source
  if (source !== 'existing') req.id = id
  if (!res.headersSent) res.setHeader(policy.header, id)
}

/**
 * on-headers runs the callback synchronously inside res.writeHead, i.e. after the application's last chance to
 * set headers and before they are serialized. It fires at most once per response. We use it to record the
 * header time (for the log) and, if enabled, to write Server-Timing.
 */
function attachHeaderHook (res, state, settings, warn) {
  const timing = settings.enabled ? createServerTiming({ maxEntries: settings.maxEntries }) : null
  res.serverTiming = timing === null ? NOOP_SERVER_TIMING : timing.api

  onHeaders(res, function onResponseHeaders () {
    try {
      const at = nowNs()
      state.headersAt = at
      if (timing !== null) {
        const value = timing.seal(elapsedMs(state.startedAt, at))
        res.setHeader('Server-Timing', mergeHeaderValue(res.getHeader('Server-Timing'), value))
      }
    } catch (err) {
      // Throwing here would surface inside the application's res.send()/res.end() call.
      warn('failed to write Server-Timing header', err)
    }
  })
}

/**
 * Call `listener(finished)` exactly once when the response is over (ADR-0007).
 *
 * - 'finish' first: the last chunk was handed to the OS -> listener(true).
 * - 'close' without a prior 'finish': the connection ended first -> listener(false). On Node >= 12 every
 *   ServerResponse emits 'close', also when the client disconnects or the socket errors.
 * - Already destroyed when observe() runs (the client left during an earlier middleware): 'close' has already
 *   been emitted, so the listener is scheduled instead -> listener(false).
 * res.writableFinished is deliberately not used: once the socket is gone it can read true for a response that was
 * ended after the client had disconnected.
 */
function onResponseEnd (res, listener) {
  if (res.destroyed) {
    setImmediate(listener, false)
    return
  }
  let done = false
  res.once('finish', () => {
    if (done) return
    done = true
    listener(true)
  })
  res.once('close', () => {
    if (done) return
    done = true
    listener(false)
  })
}

/**
 * Count the termination and, with logging enabled, emit exactly one record.
 * - finished:    the response emitted 'finish' (the last chunk was handed to the OS; not proof of client receipt)
 * - interrupted: anything else (the connection ended first). This is an HTTP fact, not evidence of user intent.
 * status is only reported if headers were actually sent; Node's default statusCode 200 is not a response.
 */
function attachTermination (req, res, state, config, warn, deliver, sampler) {
  const getMatchedRoute = deliver === null ? null : trackMatchedRoute(req)

  onResponseEnd(res, function onTerminated (finished) {
    if (state.logged) return
    state.logged = true
    state.finished = finished
    if (finished) counters.finished++
    else counters.interrupted++
    if (deliver === null) return

    let record
    try {
      // Preparation failed before an ID was assigned: a record without requestId would break the schema.
      if (state.requestId === null) throw new Error('request was not prepared')
      const endedAt = nowNs()
      const headersSent = res.headersSent === true
      const fields = {
        timestamp: new Date().toISOString(),
        requestId: state.requestId,
        requestIdSource: state.requestIdSource,
        service: config.service,
        release: config.release,
        method: typeof req.method === 'string' ? req.method : null,
        route: resolveRouteLabel(req, res, getMatchedRoute(), config.route, warn),
        status: headersSent ? res.statusCode : null,
        headerDurationMs: state.headersAt === null ? null : elapsedMs(state.startedAt, state.headersAt),
        durationMs: elapsedMs(state.startedAt, endedAt),
        termination: state.finished ? 'finished' : 'interrupted'
      }
      // Largest event-loop lateness from one sampling interval before entry until now (ADR-0009). Added only
      // when enabled, so the default path builds exactly the same object as before.
      if (sampler !== null) fields.eventLoopDelayMs = sampler.maxSince(Number(state.startedAt) / 1e6 - sampler.resolutionMs)
      record = applyExtension(buildRecord(fields), config.log.extend, req, res, warn)
    } catch (err) {
      counters.dropped++
      warn('failed to build access-log record; record dropped', err)
      return
    } finally {
      if (state.sampling) sampler.release()
    }
    deliver(record)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Options

function normalizeOptions (options) {
  if (options === undefined) options = {}
  assertPlainObject(options, 'options')
  assertKnownKeys(options, ['service', 'release', 'requestId', 'serverTiming', 'route', 'log', 'eventLoop'], 'options')

  const requestId = section(options, 'requestId', ['header', 'trustIncoming', 'onExistingId'])
  const serverTiming = section(options, 'serverTiming', ['enabled', 'maxEntries'])
  const route = section(options, 'route', ['mounts', 'resolver'])
  const log = section(options, 'log', ['enabled', 'sink', 'onSinkError', 'extend'])
  const eventLoop = section(options, 'eventLoop', ['enabled', 'resolutionMs', 'idleStopMs'])

  const resolutionMs = eventLoop.resolutionMs ?? DEFAULT_EVENT_LOOP_RESOLUTION_MS
  if (!Number.isInteger(resolutionMs) || resolutionMs < 5 || resolutionMs > 1000) {
    throw new TypeError('express-observe: options.eventLoop.resolutionMs must be an integer between 5 and 1000')
  }
  const idleStopMs = eventLoop.idleStopMs ?? DEFAULT_EVENT_LOOP_IDLE_STOP_MS
  if (!Number.isInteger(idleStopMs) || (idleStopMs !== 0 && (idleStopMs < 100 || idleStopMs > 3_600_000))) {
    throw new TypeError('express-observe: options.eventLoop.idleStopMs must be 0 (never stop) or an integer between 100 and 3600000')
  }

  const header = requestId.header ?? DEFAULT_REQUEST_ID_HEADER
  if (typeof header !== 'string' || !HEADER_NAME.test(header)) {
    throw new TypeError('express-observe: options.requestId.header must be a valid HTTP header name')
  }

  const trustIncoming = requestId.trustIncoming ?? false
  if (typeof trustIncoming !== 'boolean' && typeof trustIncoming !== 'function') {
    throw new TypeError('express-observe: options.requestId.trustIncoming must be a boolean or a function')
  }

  const onExistingId = requestId.onExistingId ?? 'keep'
  if (onExistingId !== 'keep' && onExistingId !== 'replace') {
    throw new TypeError("express-observe: options.requestId.onExistingId must be 'keep' or 'replace'")
  }

  const timingEnabled = optionalBoolean(serverTiming.enabled, true, 'options.serverTiming.enabled')

  const maxEntries = serverTiming.maxEntries ?? DEFAULT_MAX_TIMING_ENTRIES
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_TIMING_ENTRIES_LIMIT) {
    throw new TypeError(
      `express-observe: options.serverTiming.maxEntries must be an integer between 1 and ${MAX_TIMING_ENTRIES_LIMIT}`
    )
  }

  return {
    service: normalizeLabel(options.service, 'options.service'),
    release: normalizeLabel(options.release, 'options.release'),
    requestId: {
      header,
      headerKey: header.toLowerCase(),
      trustIncoming,
      onExistingId
    },
    serverTiming: { enabled: timingEnabled, maxEntries },
    eventLoop: { enabled: optionalBoolean(eventLoop.enabled, false, 'options.eventLoop.enabled'), resolutionMs, idleStopMs },
    route: {
      mounts: compileMounts(route.mounts),
      resolver: optionalFunction(route.resolver, 'options.route.resolver')
    },
    log: {
      enabled: optionalBoolean(log.enabled, true, 'options.log.enabled'),
      sink: optionalFunction(log.sink, 'options.log.sink') ?? defaultSink,
      onSinkError: optionalFunction(log.onSinkError, 'options.log.onSinkError'),
      extend: optionalFunction(log.extend, 'options.log.extend')
    }
  }
}

function section (options, key, allowed) {
  const value = options[key] === undefined ? {} : options[key]
  assertPlainObject(value, `options.${key}`)
  assertKnownKeys(value, allowed, `options.${key}`)
  return value
}

function optionalBoolean (value, fallback, path) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`express-observe: ${path} must be a boolean`)
  return value
}

function optionalFunction (value, path) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'function') throw new TypeError(`express-observe: ${path} must be a function`)
  return value
}

function normalizeLabel (value, path) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    throw new TypeError(`express-observe: ${path} must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`)
  }
  return value
}

function assertPlainObject (value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`express-observe: ${path} must be an object`)
  }
}

function assertKnownKeys (value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`express-observe: unknown option ${path}.${key}`)
    }
  }
}

module.exports = observe
module.exports.observe = observe
module.exports.getDiagnostics = getDiagnostics
