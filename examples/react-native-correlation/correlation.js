'use strict'

// Platform-neutral client-side correlation for express-observe. Runs unchanged in React Native (Hermes) and in
// Node 22: it only uses fetch, AbortController and an injected clock and ID generator. No Node or RN imports.
//
// Vocabulary (ARCHITECTURE.md section 9):
//   clientAttemptMs  one physical HTTP attempt as the client saw it: request start until the body was parsed
//   responseMs       request start until fetch() resolved. In browsers and Node that is when headers arrived;
//                    React Native's fetch is built on XMLHttpRequest and may resolve only after the whole body
//   operationMs      a user action until a usable UI result; measured by the app, not here
// The difference between clientAttemptMs and the server's durationMs is NOT network time. It mixes connection
// setup, queueing, transfer, kernel buffers and client parsing, and the two clocks start and stop at different
// points.

const CLIENT_SCHEMA_VERSION = 1
const LOG_MARKER = 'client-attempt'
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Lenient Server-Timing parser for display: unknown parameters are kept, malformed metrics are skipped.
 * @param {string | null | undefined} value
 * @returns {{ name: string, dur: number | null, desc: string | null }[]}
 */
function parseServerTiming (value) {
  if (typeof value !== 'string' || value.length === 0) return []
  const metrics = []
  for (const raw of splitOutsideQuotes(value, ',')) {
    const [name, ...params] = splitOutsideQuotes(raw, ';')
    if (!TOKEN.test(name)) continue
    const metric = { name, dur: null, desc: null }
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq === -1) continue
      const key = param.slice(0, eq).trim().toLowerCase()
      let val = param.slice(eq + 1).trim()
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1')
      if (key === 'dur' && metric.dur === null && /^\d+(\.\d+)?$/.test(val)) metric.dur = Number(val)
      if (key === 'desc' && metric.desc === null) metric.desc = val
    }
    metrics.push(metric)
  }
  return metrics
}

function splitOutsideQuotes (input, separator) {
  const parts = []
  let current = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted && ch === '\\') {
      current += ch + (input[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') quoted = !quoted
    if (ch === separator && !quoted) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current.trim())
  return parts.filter((p) => p.length > 0)
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10)

/**
 * @param {object} options
 * @param {string} options.baseUrl              e.g. http://10.0.2.2:4000 on the Android emulator
 * @param {() => string} options.newId          ID generator; must return 1-128 chars of [A-Za-z0-9._-]
 * @param {() => number} [options.now]          monotonic clock in ms (default performance.now)
 * @param {() => string} [options.wallClock]    ISO timestamp for logs (default new Date().toISOString())
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.requestIdHeader]   default X-Request-Id
 * @param {number} [options.timeoutMs]          per attempt, default 10000
 * @param {(attempt: object) => void} [options.onAttempt]  called once per finished attempt
 */
function createTracedClient (options) {
  const baseUrl = String(options.baseUrl).replace(/\/+$/, '')
  const newId = options.newId
  const now = options.now ?? (() => globalThis.performance.now())
  const wallClock = options.wallClock ?? (() => new Date().toISOString())
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const headerName = options.requestIdHeader ?? 'X-Request-Id'
  const defaultTimeoutMs = options.timeoutMs ?? 10_000
  const onAttempt = options.onAttempt ?? (() => {})
  if (typeof newId !== 'function') throw new TypeError('createTracedClient: newId must be a function')
  if (typeof fetchImpl !== 'function') throw new TypeError('createTracedClient: no fetch implementation available')

  function nextId () {
    const id = newId()
    if (typeof id !== 'string' || !VALID_ID.test(id)) {
      throw new TypeError('createTracedClient: newId() must return 1-128 characters of A-Z a-z 0-9 . _ -')
    }
    return id
  }

  async function attemptOnce ({ operationId, operationName, attempt, path, timeoutMs }) {
    const requestId = nextId()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    const record = {
      kind: LOG_MARKER,
      schemaVersion: CLIENT_SCHEMA_VERSION,
      startedAt: wallClock(),
      operationId,
      operationName,
      attempt,
      path,
      requestId,
      outcome: null,
      status: null,
      serverRequestId: null,
      requestIdEchoed: null,
      serverTiming: [],
      serverAppMs: null,
      responseMs: null,
      clientAttemptMs: null,
      bodyBytes: null
    }
    const t0 = now()
    let data = null
    try {
      const response = await fetchImpl(baseUrl + path, {
        method: 'GET',
        headers: { [headerName]: requestId, Accept: 'application/json' },
        signal: controller.signal
      })
      record.responseMs = round1(now() - t0)
      record.status = response.status
      record.serverRequestId = response.headers.get(headerName)
      record.requestIdEchoed = record.serverRequestId === requestId
      record.serverTiming = parseServerTiming(response.headers.get('server-timing'))
      const app = record.serverTiming.find((m) => m.name === 'app')
      record.serverAppMs = app ? app.dur : null

      const text = await response.text()
      record.bodyBytes = text.length
      try {
        data = text.length > 0 ? JSON.parse(text) : null
        record.outcome = response.ok ? 'ok' : 'http-error'
      } catch {
        record.outcome = 'parse-error'
      }
    } catch (err) {
      record.outcome = timedOut ? 'timeout' : 'network-error'
    } finally {
      clearTimeout(timer)
      record.clientAttemptMs = round1(now() - t0)
    }
    onAttempt(record)
    return { record, data }
  }

  /**
   * One logical operation, possibly several physical attempts. Each attempt gets its own request ID.
   * @param {string} path  must start with "/"
   * @param {{ operationName?: string, maxAttempts?: number, timeoutMs?: number,
   *           retryOn?: (record: object) => boolean }} [opts]
   */
  async function request (path, opts = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('request: path must start with "/"')
    const operationId = nextId()
    const operationName = opts.operationName ?? path
    const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 1, 5))
    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
    const retryOn = opts.retryOn ?? ((r) => r.outcome === 'network-error' || r.outcome === 'timeout' || (r.status !== null && r.status >= 500))

    const attempts = []
    const t0 = now()
    let last = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await attemptOnce({ operationId, operationName, attempt, path, timeoutMs })
      attempts.push(last.record)
      if (!retryOn(last.record)) break
    }
    return {
      ok: last.record.outcome === 'ok',
      data: last.data,
      operation: {
        operationId,
        operationName,
        attempts,
        outcome: last.record.outcome,
        // Network-level span of the operation only; the app measures the user-visible operationMs.
        requestsMs: round1(now() - t0)
      }
    }
  }

  return { request }
}

/** One JSON line for an attempt, prefixed so it can be found in mixed console output. */
function formatAttemptLine (record) {
  return `${LOG_MARKER} ${JSON.stringify(record)}`
}

module.exports = {
  CLIENT_SCHEMA_VERSION,
  LOG_MARKER,
  parseServerTiming,
  createTracedClient,
  formatAttemptLine
}
