'use strict'

const onHeaders = require('on-headers')
const onFinished = require('on-finished')
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

// Per-response state lives under a symbol so it never collides with application properties.
const kState = Symbol('express-observe.state')

// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

const DEFAULT_REQUEST_ID_HEADER = 'X-Request-Id'
const DEFAULT_MAX_TIMING_ENTRIES = 16
const MAX_TIMING_ENTRIES_LIMIT = 64
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

  return function expressObserve (req, res, next) {
    // A second observe() instance on the same request is a no-op: one ID, one Server-Timing entry, one record.
    if (res[kState] !== undefined) return next()

    const state = {
      startedAt: nowNs(),
      headersAt: null,
      requestId: null,
      requestIdSource: null,
      finished: false,
      logged: false
    }

    try {
      res[kState] = state
      assignRequestId(req, res, state, config.requestId, warn)
      attachHeaderHook(res, state, config.serverTiming, warn)
      if (deliver !== null) attachAccessLog(req, res, state, config, warn, deliver)
    } catch (err) {
      warn('internal error while preparing request; continuing without full observation', err)
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
 * Emit exactly one record when the response terminates.
 *
 * on-finished fires once, on the first of: response 'finish', socket 'close', socket 'error'.
 * - finished:    the response emitted 'finish' (the last chunk was handed to the OS; not proof of client receipt)
 * - interrupted: anything else (the connection ended first). This is an HTTP fact, not evidence of user intent.
 * status is only reported if headers were actually sent; Node's default statusCode 200 is not a response.
 *
 * Termination is decided by the 'finish' event, not by res.writableFinished: once the socket is gone,
 * writableFinished can read true for a response that was ended after the client had already disconnected.
 */
function attachAccessLog (req, res, state, config, warn, deliver) {
  const getMatchedRoute = trackMatchedRoute(req)
  res.once('finish', () => { state.finished = true })

  onFinished(res, function onTerminated () {
    if (state.logged) return
    state.logged = true
    try {
      const endedAt = nowNs()
      const headersSent = res.headersSent === true
      const record = buildRecord({
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
      })
      deliver(applyExtension(record, config.log.extend, req, res, warn))
    } catch (err) {
      warn('failed to build access-log record; record dropped', err)
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Options

function normalizeOptions (options) {
  if (options === undefined) options = {}
  assertPlainObject(options, 'options')
  assertKnownKeys(options, ['service', 'release', 'requestId', 'serverTiming', 'route', 'log'], 'options')

  const requestId = section(options, 'requestId', ['header', 'trustIncoming', 'onExistingId'])
  const serverTiming = section(options, 'serverTiming', ['enabled', 'maxEntries'])
  const route = section(options, 'route', ['mounts', 'resolver'])
  const log = section(options, 'log', ['enabled', 'sink', 'onSinkError', 'extend'])

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
