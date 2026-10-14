'use strict'

// W3C Server-Timing (Working Draft, 2026-04-07): `metric-name *( OWS ";" OWS server-timing-param )`.
// We accept a conservative subset of the HTTP token grammar for names.
const VALID_NAME = /^[A-Za-z0-9_-]{1,32}$/
const RESERVED_NAME = 'app'
const MAX_DESC_LENGTH = 64

function nowNs () {
  return process.hrtime.bigint()
}

function elapsedMs (fromNs, toNs) {
  return Number(toNs - fromNs) / 1e6
}

function isValidName (name) {
  return typeof name === 'string' && name !== RESERVED_NAME && VALID_NAME.test(name)
}

function isValidDuration (ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
}

// Printable ASCII only (header values outside latin1 make Node throw), truncated, then quoted-string escaped.
function sanitizeDesc (desc) {
  if (typeof desc !== 'string') return undefined
  const cleaned = desc.replace(/[^\x20-\x7E]/g, '').slice(0, MAX_DESC_LENGTH)
  if (cleaned.length === 0) return undefined
  return cleaned.replace(/[\\"]/g, (ch) => '\\' + ch)
}

function formatEntry (name, durationMs, desc) {
  let out = `${name};dur=${durationMs.toFixed(1)}`
  if (desc !== undefined) out += `;desc="${desc}"`
  return out
}

/**
 * Per-response timer registry.
 *
 * Rules (see ARCHITECTURE.md section 4.2):
 * - Names: 1-32 chars of [A-Za-z0-9_-]; "app" is reserved for the built-in metric. Invalid names are ignored.
 * - At most `maxEntries` distinct names; further names are ignored.
 * - start() on a running name restarts it. end() replaces any earlier duration for that name (latest wins).
 * - end() without a running start() is ignored. Unfinished timers are omitted from the header.
 * - After seal() (headers flushed) every call is a silent no-op.
 * - No method throws and every method returns undefined.
 *
 * @param {{ maxEntries: number }} options
 */
function createServerTiming ({ maxEntries }) {
  /** @type {Map<string, { startedAt: bigint | null, durationMs: number | null, desc: string | undefined }>} */
  const entries = new Map()
  let sealed = false

  function getOrCreate (name) {
    let entry = entries.get(name)
    if (entry === undefined) {
      if (entries.size >= maxEntries) return undefined
      entry = { startedAt: null, durationMs: null, desc: undefined }
      entries.set(name, entry)
    }
    return entry
  }

  function start (name) {
    if (sealed || !isValidName(name)) return
    const entry = getOrCreate(name)
    if (entry !== undefined) entry.startedAt = nowNs()
  }

  function end (name) {
    if (sealed || !isValidName(name)) return
    const entry = entries.get(name)
    if (entry === undefined || entry.startedAt === null) return
    entry.durationMs = elapsedMs(entry.startedAt, nowNs())
    entry.startedAt = null
  }

  function add (name, durationMs, desc) {
    if (sealed || !isValidName(name) || !isValidDuration(durationMs)) return
    const entry = getOrCreate(name)
    if (entry === undefined) return
    entry.durationMs = durationMs
    entry.desc = sanitizeDesc(desc)
  }

  /**
   * Freeze the registry and produce the header value.
   * @param {number} appDurationMs time from middleware entry to header flush
   * @returns {string}
   */
  function seal (appDurationMs) {
    sealed = true
    const parts = []
    for (const [name, entry] of entries) {
      if (entry.durationMs !== null) parts.push(formatEntry(name, entry.durationMs, entry.desc))
    }
    parts.push(formatEntry(RESERVED_NAME, appDurationMs, undefined))
    return parts.join(', ')
  }

  const api = Object.freeze({
    start: guard(start),
    end: guard(end),
    add: guard(add)
  })

  return { api, seal }
}

// Belt-and-braces: the public API must never throw into application code.
function guard (fn) {
  return function guarded (...args) {
    try {
      fn(...args)
    } catch {
      // intentionally ignored; inputs are validated above
    }
  }
}

/** Used when serverTiming is disabled so application code calling res.serverTiming.* keeps working. */
const NOOP_SERVER_TIMING = Object.freeze({
  start () {},
  end () {},
  add () {}
})

/**
 * Merge our value with any Server-Timing header the application already set.
 * Server-Timing is a list-based header, so combining with ", " or multiple field lines is equivalent.
 */
function mergeHeaderValue (existing, ours) {
  if (existing === undefined || existing === null || existing === '') return ours
  if (Array.isArray(existing)) return [...existing, ours]
  return `${existing}, ${ours}`
}

module.exports = {
  RESERVED_NAME,
  nowNs,
  elapsedMs,
  createServerTiming,
  mergeHeaderValue,
  NOOP_SERVER_TIMING
}
