'use strict'

// Aggregates express-observe access-log lines into per-group statistics. Pure: no I/O besides the line source
// handed to analyzeLines(). See docs/decisions/0004-analyze-cli.md.

const readline = require('node:readline')

const REPORT_VERSION = 1
const SUPPORTED_SCHEMA_VERSION = 1
const MAX_LINE_LENGTH = 64 * 1024
const MAX_FIELD_LENGTH = 1024
const MAX_SLOWEST = 100
const MIN_SAMPLES = Object.freeze({ p95: 20, p99: 100 })
const GROUP_BY = Object.freeze(['method-route', 'route', 'service', 'release'])
const SORT_BY = Object.freeze(['count', 'p95', 'p99', 'errors', 'interrupted'])
const LOOP_BLOCKED_MS = 50
const UNKNOWN_ROUTE = '(unknown route)'
const UNSET = '(not set)'

/** Growable Float64Array: two numbers per finished request is the main memory cost. */
class Series {
  constructor () {
    this.values = new Float64Array(64)
    this.length = 0
  }

  push (value) {
    if (this.length === this.values.length) {
      const next = new Float64Array(this.values.length * 2)
      next.set(this.values)
      this.values = next
    }
    this.values[this.length++] = value
  }

  summary (withMax) {
    const n = this.length
    const sorted = this.values.slice(0, n).sort()
    const at = (p) => sorted[Math.min(n, Math.max(1, Math.ceil((p / 100) * n))) - 1]
    const out = {
      n,
      p50: n > 0 ? round3(at(50)) : null,
      p95: n >= MIN_SAMPLES.p95 ? round3(at(95)) : null,
      p99: n >= MIN_SAMPLES.p99 ? round3(at(99)) : null
    }
    if (withMax) out.max = n > 0 ? round3(sorted[n - 1]) : null
    return out
  }
}

function round3 (n) {
  return Math.round(n * 1000) / 1000
}

function isShortString (value, max = MAX_FIELD_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isDuration (value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Classify one parsed JSON value.
 * @returns {{ record: object } | { skip: 'notRecord' | 'unsupportedSchema' | 'invalid' }}
 */
function classify (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { skip: 'notRecord' }
  if (!('schemaVersion' in value) || !('requestId' in value) || !('termination' in value)) return { skip: 'notRecord' }
  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return { skip: 'unsupportedSchema' }

  const valid =
    isShortString(value.requestId, 256) &&
    (value.termination === 'finished' || value.termination === 'interrupted') &&
    isShortString(value.method, 32) &&
    (value.route === null || isShortString(value.route)) &&
    (value.status === null || (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)) &&
    isDuration(value.durationMs) &&
    (!('eventLoopDelayMs' in value) || value.eventLoopDelayMs === null || isDuration(value.eventLoopDelayMs)) &&
    (value.headerDurationMs === null || isDuration(value.headerDurationMs)) &&
    (value.service === null || value.service === undefined || isShortString(value.service)) &&
    (value.release === null || value.release === undefined || isShortString(value.release)) &&
    typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))
  return valid ? { record: value } : { skip: 'invalid' }
}

function groupKey (record, groupBy) {
  switch (groupBy) {
    case 'route':
      return record.route ?? UNKNOWN_ROUTE
    case 'service':
      return record.service ?? UNSET
    case 'release':
      return record.release ?? UNSET
    default:
      return `${record.method} ${record.route ?? UNKNOWN_ROUTE}`
  }
}

function newGroup (key) {
  return {
    key,
    count: 0,
    finished: 0,
    interrupted: 0,
    status: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, none: 0 },
    hasUnknownRoute: false,
    duration: new Series(),
    header: new Series(),
    loop: new Series(),
    loopBlocked: 0
  }
}

function addToGroup (group, record) {
  group.count++
  // Optional field (ADR-0009). Process-level, so it is aggregated for finished and interrupted requests alike.
  if (typeof record.eventLoopDelayMs === 'number') {
    group.loop.push(record.eventLoopDelayMs)
    if (record.eventLoopDelayMs >= LOOP_BLOCKED_MS) group.loopBlocked++
  }
  if (record.route === null) group.hasUnknownRoute = true
  if (record.status === null) group.status.none++
  else group.status[`${Math.floor(record.status / 100)}xx`]++

  if (record.termination === 'interrupted') {
    group.interrupted++
    return
  }
  group.finished++
  group.duration.push(record.durationMs)
  if (record.headerDurationMs !== null) group.header.push(record.headerDurationMs)
}

function finalizeGroup (group) {
  const rate = (part) => (group.count > 0 ? round3(part / group.count) : null)
  return {
    key: group.key,
    count: group.count,
    finished: group.finished,
    interrupted: group.interrupted,
    interruptedRate: rate(group.interrupted),
    status: { ...group.status },
    errorRate5xx: rate(group.status['5xx']),
    durationMs: group.duration.summary(true),
    headerDurationMs: group.header.summary(false),
    eventLoopDelayMs: group.loop.length > 0 ? { ...group.loop.summary(true), blocked: group.loopBlocked } : null
  }
}

const SORTERS = {
  count: (a, b) => b.count - a.count,
  p95: (a, b) => (b.durationMs.p95 ?? -1) - (a.durationMs.p95 ?? -1) || b.count - a.count,
  p99: (a, b) => (b.durationMs.p99 ?? -1) - (a.durationMs.p99 ?? -1) || b.count - a.count,
  errors: (a, b) => b.status['5xx'] - a.status['5xx'] || b.count - a.count,
  interrupted: (a, b) => b.interrupted - a.interrupted || b.count - a.count
}

/**
 * @param {{ groupBy?: string, sortBy?: string, top?: number, since?: number | null, until?: number | null,
 *           slowest?: number }} [options] since/until are epoch milliseconds
 */
function createAnalyzer (options = {}) {
  const groupBy = options.groupBy ?? 'method-route'
  const sortBy = options.sortBy ?? 'count'
  const top = options.top ?? 20
  const since = options.since ?? null
  const until = options.until ?? null
  const slowestLimit = Math.min(options.slowest ?? 0, MAX_SLOWEST)

  const skipped = { notJson: 0, notRecord: 0, unsupportedSchema: 0, invalid: 0, outsideWindow: 0, tooLong: 0 }
  const groups = new Map()
  const totals = newGroup('(all)')
  const services = new Set()
  const releases = new Set()
  const slowest = []
  let linesRead = 0
  let first = null
  let last = null

  function trackSlowest (record) {
    if (slowestLimit === 0 || record.termination !== 'finished') return
    if (slowest.length === slowestLimit && record.durationMs <= slowest[slowest.length - 1].durationMs) return
    const entry = {
      requestId: record.requestId,
      timestamp: record.timestamp,
      method: record.method,
      route: record.route,
      status: record.status,
      headerDurationMs: record.headerDurationMs,
      durationMs: record.durationMs
    }
    let i = slowest.length
    while (i > 0 && slowest[i - 1].durationMs < entry.durationMs) i--
    slowest.splice(i, 0, entry)
    if (slowest.length > slowestLimit) slowest.pop()
  }

  function addLine (line) {
    linesRead++
    const text = line.trim()
    if (text.length === 0) {
      linesRead--
      return
    }
    if (text.length > MAX_LINE_LENGTH) {
      skipped.tooLong++
      return
    }
    let value
    try {
      value = JSON.parse(text)
    } catch {
      skipped.notJson++
      return
    }
    const result = classify(value)
    if (result.skip) {
      skipped[result.skip]++
      return
    }
    const record = result.record
    const t = Date.parse(record.timestamp)
    if ((since !== null && t < since) || (until !== null && t > until)) {
      skipped.outsideWindow++
      return
    }

    if (first === null || t < first) first = t
    if (last === null || t > last) last = t
    services.add(record.service ?? null)
    releases.add(record.release ?? null)

    const key = groupKey(record, groupBy)
    let group = groups.get(key)
    if (group === undefined) {
      group = newGroup(key)
      groups.set(key, group)
    }
    addToGroup(group, record)
    addToGroup(totals, record)
    trackSlowest(record)
  }

  function report () {
    const all = [...groups.values()].map(finalizeGroup).sort(SORTERS[sortBy])
    const shown = top === 0 ? all : all.slice(0, top)
    const total = finalizeGroup(totals)
    return {
      reportVersion: REPORT_VERSION,
      input: {
        linesRead,
        records: totals.count,
        skipped: { ...skipped },
        skippedTotal: Object.values(skipped).reduce((a, b) => a + b, 0)
      },
      window: {
        first: first === null ? null : new Date(first).toISOString(),
        last: last === null ? null : new Date(last).toISOString(),
        since: since === null ? null : new Date(since).toISOString(),
        until: until === null ? null : new Date(until).toISOString()
      },
      services: [...services].sort(nullsLast),
      releases: [...releases].sort(nullsLast),
      groupBy,
      sortBy,
      groupsTotal: all.length,
      groups: shown,
      totals: total,
      slowest: slowest.slice(),
      notes: buildNotes({ all, total, groupBy, services, releases, skipped, shownCount: shown.length })
    }
  }

  return { addLine, report }
}

function nullsLast (a, b) {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

function buildNotes ({ all, total, groupBy, services, releases, skipped, shownCount }) {
  const notes = []
  const unknown = all.filter((g) => g.key.endsWith(UNKNOWN_ROUTE)).reduce((n, g) => n + g.count, 0)
  if ((groupBy === 'method-route' || groupBy === 'route') && unknown > 0) {
    notes.push(`${unknown} request(s) have no route template: unmatched URLs, or responses from middleware that were not labelled. The log cannot say which.`)
  }
  if (total.interrupted > 0) {
    notes.push(`${total.interrupted} request(s) were interrupted: the connection ended before the response finished. This does not say whether a user cancelled, a proxy timed out or the network failed. Interrupted requests are excluded from latency percentiles.`)
  }
  if (services.size > 1 && groupBy !== 'service') {
    notes.push(`Records from ${services.size} services are mixed in these groups. Use --by service, or analyze each service separately.`)
  }
  if (releases.size > 1 && groupBy !== 'release') {
    notes.push(`Records from ${releases.size} releases are mixed in these groups, which can hide a regression. Use --by release to compare them.`)
  }
  if (total.eventLoopDelayMs !== null && total.eventLoopDelayMs.blocked > 0) {
    notes.push(`${total.eventLoopDelayMs.blocked} request(s) saw the event loop blocked for ${LOOP_BLOCKED_MS} ms or more. Requests that arrive during a block wait before observe() runs, so their durationMs understates what their clients waited. eventLoopDelayMs says the process was blocked, not which code blocked it.`)
  }
  const withheld = all.filter((g) => g.durationMs.n > 0 && (g.durationMs.p95 === null || g.durationMs.p99 === null)).length
  if (withheld > 0) {
    notes.push(`${withheld} group(s) have too few finished requests for some percentiles (p95 needs ${MIN_SAMPLES.p95}, p99 needs ${MIN_SAMPLES.p99}); those are shown as "-" rather than guessed.`)
  }
  if (all.length > shownCount) {
    notes.push(`Showing ${shownCount} of ${all.length} groups. Use --top 0 to show all.`)
  }
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0)
  if (skippedTotal > 0) {
    notes.push(`${skippedTotal} line(s) were skipped; they are not part of any number above.`)
  }
  notes.push('All durations are server-side, from middleware entry. Client-perceived time, network time and requests still in progress when the log was cut are not in this data.')
  return notes
}

/**
 * Feed every line of a readable stream into an analyzer. Handles LF and CRLF line endings.
 * @param {import('stream').Readable} input
 * @param {{ addLine: (line: string) => void }} analyzer
 */
async function analyzeStream (input, analyzer) {
  // On Node 22 the readline iterator already rejects on input errors (ENOENT, EISDIR, ...). The explicit capture
  // is a safeguard so an error that arrives together with 'close' is still reported rather than read as EOF.
  let streamError = null
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  input.once('error', (err) => {
    streamError = err
    rl.close()
  })
  for await (const line of rl) analyzer.addLine(line)
  if (streamError !== null) throw streamError
}

module.exports = {
  REPORT_VERSION,
  classifyRecord: classify,
  MIN_SAMPLES,
  GROUP_BY,
  SORT_BY,
  MAX_SLOWEST,
  createAnalyzer,
  analyzeStream
}
