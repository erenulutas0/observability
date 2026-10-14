'use strict'

// Joins client attempts (from correlation.js) with express-observe access-log records by request ID, and renders
// what each side can and cannot say. Pure functions; join-cli.js does the file I/O.

const { LOG_MARKER } = require('./correlation')

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10)

/** Below this client attempt time, a client/server split is not worth interpreting. */
const MEANINGFUL_MS = 20

/**
 * Extract client attempts from text lines. Accepts raw JSON lines and lines where the JSON follows the
 * "client-attempt " marker anywhere (Metro and Expo prefix console output with "LOG" and timestamps).
 */
function parseClientLines (lines) {
  const attempts = []
  for (const line of lines) {
    const at = line.indexOf(`${LOG_MARKER} {`)
    const text = at >= 0 ? line.slice(at + LOG_MARKER.length + 1) : line.trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text)
      if (value && value.kind === LOG_MARKER && typeof value.requestId === 'string') attempts.push(value)
    } catch {
      // not a client attempt line
    }
  }
  return attempts
}

/** Extract express-observe records from access-log lines (also when wrapped by another logger). */
function parseServerLines (lines) {
  const records = []
  for (const line of lines) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text)
      if (value && value.schemaVersion === 1 && typeof value.requestId === 'string' && 'termination' in value) records.push(value)
    } catch {
      // not a record
    }
  }
  return records
}

/**
 * @returns {object[]} one row per client attempt, in client order
 */
function joinAttempts (clientAttempts, serverRecords) {
  const byId = new Map()
  for (const r of serverRecords) {
    if (!byId.has(r.requestId)) byId.set(r.requestId, [])
    byId.get(r.requestId).push(r)
  }

  return clientAttempts.map((c) => {
    let matches = byId.get(c.requestId) ?? []
    let matchedBy = matches.length > 0 ? 'sent-id' : null
    if (matches.length === 0 && c.serverRequestId) {
      matches = byId.get(c.serverRequestId) ?? []
      matchedBy = matches.length > 0 ? 'response-header' : null
    }
    const server = matches[0] ?? null
    const row = {
      operationId: c.operationId,
      operationName: c.operationName,
      attempt: c.attempt,
      requestId: c.requestId,
      clientOutcome: c.outcome,
      clientStatus: c.status,
      clientAttemptMs: c.clientAttemptMs,
      serverAppMs: c.serverAppMs,
      matchedBy,
      duplicateServerRecords: matches.length > 1 ? matches.length : 0,
      server: server && {
        requestIdSource: server.requestIdSource,
        route: server.route,
        status: server.status,
        termination: server.termination,
        headerDurationMs: server.headerDurationMs,
        durationMs: server.durationMs
      },
      notMeasuredByServerMs: null,
      reading: ''
    }

    if (server === null) {
      row.reading = c.outcome === 'network-error' || c.outcome === 'timeout'
        ? 'No server record: the request may never have reached the server, or the log is incomplete. Unknown which.'
        : 'No server record: the server did not trust the client ID and no response ID is available, or the log is incomplete.'
    } else if (server.termination === 'interrupted') {
      row.reading = c.outcome === 'timeout'
        ? `The client gave up after ${round1(c.clientAttemptMs)} ms; the server saw the connection end after ${round1(server.durationMs)} ms${server.status === null ? ', before it sent any header' : ''}. Why the server was slow is not in these records.`
        : 'The server saw the connection end before the response finished. The client and server views of the cause may differ.'
    } else if (c.outcome === 'ok' || c.outcome === 'http-error') {
      row.notMeasuredByServerMs = round1(c.clientAttemptMs - server.durationMs)
      const share = c.clientAttemptMs > 0 ? row.notMeasuredByServerMs / c.clientAttemptMs : 0
      row.reading = c.clientAttemptMs < MEANINGFUL_MS
        ? `Fast end to end (under ${MEANINGFUL_MS} ms); at this scale the split between client and server is noise.`
        : share >= 0.5
        ? 'Most of this attempt was spent outside what the server measured (connection, queueing, transfer, client parsing). These records cannot split that further.'
        : 'Most of this attempt was spent inside the server\'s measured time.'
    } else {
      row.reading = `Client outcome ${c.outcome}; compare with the server status ${server.status}.`
    }
    if (row.duplicateServerRecords > 0) row.reading += ` Warning: ${row.duplicateServerRecords} server records share this ID.`
    return row
  })
}

function safe (value) {
  return String(value).replace(/[^\x20-\x7E]/g, '?')
}

function fmt (n) {
  return n === null || n === undefined ? '-' : n.toFixed(1)
}

function renderJoin (rows) {
  const out = []
  const headers = ['OPERATION', 'TRY', 'CLIENT', 'CLIENT MS', 'SERVER', 'SERVER MS', 'HEADER MS', 'NOT MEASURED BY SERVER MS']
  const table = rows.map((r) => [
    safe(r.operationName).slice(0, 32),
    String(r.attempt),
    r.clientStatus === null ? safe(r.clientOutcome) : `${r.clientStatus} ${safe(r.clientOutcome)}`,
    fmt(r.clientAttemptMs),
    r.server === null ? 'no record' : `${r.server.status ?? '-'} ${r.server.termination}`,
    fmt(r.server && r.server.durationMs),
    fmt(r.server && r.server.headerDurationMs),
    fmt(r.notMeasuredByServerMs)
  ])
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)))
  const line = (cells) => cells.map((c, i) => (i === 0 || i === 2 || i === 4 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd()
  out.push(line(headers))
  out.push(line(widths.map((w) => '-'.repeat(w))))
  for (const row of table) out.push(line(row))
  out.push('')
  rows.forEach((r, i) => out.push(`${i + 1}. ${safe(r.operationName)} try ${r.attempt}: ${safe(r.reading)}`))
  out.push('')
  out.push('NOT MEASURED BY SERVER = client attempt time minus server durationMs. It is not network time: it mixes')
  out.push('connection setup, queueing, transfer and client-side parsing, and the two clocks start and stop at different points.')
  return out.join('\n') + '\n'
}

module.exports = { parseClientLines, parseServerLines, joinAttempts, renderJoin }
