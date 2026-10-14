'use strict'

/**
 * Independent parser for Server-Timing header values, written against the W3C grammar rather than against our
 * serializer, so tests check the wire format and not our own string building.
 *
 * Returns [{ name, dur, desc, params }]. `dur` is a number or undefined.
 * @param {string | undefined} value
 */
function parseServerTiming (value) {
  if (value === undefined) return []
  const metrics = []
  for (const rawMetric of splitOutsideQuotes(value, ',')) {
    const parts = splitOutsideQuotes(rawMetric, ';').map((p) => p.trim())
    const name = parts.shift()
    if (!name) continue
    const params = {}
    for (const part of parts) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      const key = part.slice(0, eq).trim().toLowerCase()
      let val = part.slice(eq + 1).trim()
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/\\(.)/g, '$1')
      }
      if (!(key in params)) params[key] = val
    }
    metrics.push({
      name,
      dur: params.dur === undefined ? undefined : Number(params.dur),
      desc: params.desc,
      params
    })
  }
  return metrics
}

function splitOutsideQuotes (input, separator) {
  const out = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inQuotes && ch === '\\' && i + 1 < input.length) {
      current += ch + input[i + 1]
      i++
      continue
    }
    if (ch === '"') inQuotes = !inQuotes
    if (ch === separator && !inQuotes) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

module.exports = { parseServerTiming }
