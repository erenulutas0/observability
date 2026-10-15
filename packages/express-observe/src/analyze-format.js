'use strict'

// Plain-text rendering of an analyze report. Every string that came from a log file is reduced to printable
// ASCII before printing, so a crafted log line cannot inject terminal escape sequences.

const MAX_KEY_WIDTH = 60

function safe (value) {
  return String(value).replace(/[^\x20-\x7E]/g, '?')
}

function truncate (text, width) {
  return text.length <= width ? text : text.slice(0, width - 3) + '...'
}

function ms (value) {
  return value === null || value === undefined ? '-' : value.toFixed(1)
}

function pct (value) {
  return value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`
}

function table (headers, rows, alignRight) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells
    .map((c, i) => (alignRight[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
    .join('  ')
    .trimEnd()
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

function groupRow (g, withLoop) {
  const row = [
    truncate(safe(g.key), MAX_KEY_WIDTH),
    String(g.count),
    pct(g.errorRate5xx),
    String(g.interrupted),
    ms(g.durationMs.p50),
    ms(g.durationMs.p95),
    ms(g.durationMs.p99),
    ms(g.durationMs.max),
    ms(g.headerDurationMs.p95)
  ]
  if (withLoop) row.push(g.eventLoopDelayMs === null ? '-' : ms(g.eventLoopDelayMs.max))
  return row
}

function describeSkipped (skipped) {
  const labels = {
    notJson: 'not JSON',
    notRecord: 'not an express-observe record',
    unsupportedSchema: 'unsupported schemaVersion',
    invalid: 'invalid fields',
    outsideWindow: 'outside --since/--until',
    tooLong: 'longer than 64 KiB'
  }
  return Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${labels[k]}`)
    .join(', ')
}

function list (values) {
  return values.map((v) => (v === null ? '(not set)' : safe(v))).join(', ')
}

/**
 * @param {object} report from createAnalyzer().report()
 * @param {string[]} sources input names, for the header line
 */
function renderText (report, sources) {
  const out = []
  const skippedText = report.input.skippedTotal > 0 ? ` (skipped ${report.input.skippedTotal}: ${describeSkipped(report.input.skipped)})` : ''
  out.push(`express-observe analyze: ${report.input.records} records from ${sources.map(safe).join(', ')}${skippedText}`)
  out.push(`window:   ${report.window.first ?? '-'} .. ${report.window.last ?? '-'}${report.window.since || report.window.until ? `  (filter ${report.window.since ?? '-'} .. ${report.window.until ?? '-'})` : ''}`)
  out.push(`services: ${list(report.services)}`)
  out.push(`releases: ${list(report.releases)}`)
  out.push('scope:    records in this input only; sampling or loss before it is unknown')
  out.push('')

  // The event-loop column appears only when the records carry eventLoopDelayMs (ADR-0009).
  const withLoop = report.totals.eventLoopDelayMs !== null
  const headers = [report.groupBy.toUpperCase(), 'COUNT', '5XX', 'INTERRUPTED', 'P50 MS', 'P95 MS', 'P99 MS', 'MAX MS', 'HEADER P95 MS']
  if (withLoop) headers.push('LOOP MAX MS')
  const rows = report.groups.map((g) => groupRow(g, withLoop))
  rows.push(groupRow({ ...report.totals, key: 'all requests' }, withLoop))
  out.push(table(headers, rows, headers.map((_, i) => i > 0)))
  out.push('')
  out.push(`Latency columns use finished requests only, nearest-rank percentiles; p95 needs ${report.method.minSamples.p95} and p99 needs ${report.method.minSamples.p99} values. HEADER P95 is time until response headers were sent.`)

  if (report.slowest.length > 0) {
    out.push('')
    out.push(`Slowest ${report.slowest.length} finished request(s):`)
    out.push(table(
      ['REQUEST ID', 'TIMESTAMP', 'METHOD ROUTE', 'STATUS', 'HEADER MS', 'TOTAL MS'],
      report.slowest.map((s) => [
        truncate(safe(s.requestId), 40),
        safe(s.timestamp),
        truncate(`${safe(s.method)} ${s.route === null ? '(unknown route)' : safe(s.route)}`, MAX_KEY_WIDTH),
        s.status === null ? '-' : String(s.status),
        ms(s.headerDurationMs),
        ms(s.durationMs)
      ]),
      [false, false, false, true, true, true]
    ))
  }

  out.push('')
  out.push('Notes:')
  for (const note of report.notes) out.push(`- ${safe(note)}`)
  return out.join('\n') + '\n'
}

module.exports = { renderText, safe }
