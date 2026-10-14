'use strict'

// express-observe doctor: black-box integration checks against a running server. See ADR-0005 for the security
// boundaries this module must keep: loopback by default, GET only, no credentials, bounded and sequential
// requests, log file read-only, log contents never printed.

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const readline = require('node:readline')
const { randomBytes } = require('node:crypto')
const { classifyRecord } = require('./analyze')
const { safe } = require('./analyze-format')

const REPORT_VERSION = 1
const MAX_PATHS = 10
const MAX_PATH_LENGTH = 2048
const DEFAULT_TIMEOUT_MS = 5000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_WAIT_MS = 10_000
const MARKER_QUERY_PARAM = 'express_observe_doctor'
const MARKER_HEADER = 'X-Express-Observe-Doctor'
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const QUOTED = /^"(?:[^"\\]|\\.)*"$/
const ID_LIKE_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Target and option validation (everything here runs before any connection is made)

function isLoopbackHost (hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * @param {{ url: string, paths?: string[], log?: string | null, header?: string, waitMs?: number,
 *           timeoutMs?: number, allowRemote?: boolean, version: string }} input
 */
function validateOptions (input) {
  let target
  try {
    target = new URL(input.url)
  } catch {
    throw new UsageError(`not a valid URL: ${JSON.stringify(input.url)}`)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new UsageError('the target must be an http:// or https:// URL')
  }
  if (target.username || target.password) {
    throw new UsageError('the target URL must not contain credentials; doctor never sends any')
  }
  if ((target.pathname !== '/' && target.pathname !== '') || target.search || target.hash) {
    throw new UsageError('give only the origin as the target (e.g. http://127.0.0.1:3000) and paths with --path')
  }
  if (!isLoopbackHost(target.hostname) && input.allowRemote !== true) {
    throw new UsageError(`refusing to probe ${target.hostname}: only localhost and loopback addresses are allowed without --allow-remote`)
  }

  const paths = input.paths && input.paths.length > 0 ? input.paths : ['/']
  if (paths.length > MAX_PATHS) throw new UsageError(`at most ${MAX_PATHS} --path values are allowed`)
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.length > MAX_PATH_LENGTH ||
        /[\s#\u0000-\u001f\u007f]/.test(p)) {
      throw new UsageError(`invalid --path ${JSON.stringify(p)}: it must start with a single "/" and contain no spaces, "#" or control characters`)
    }
  }

  const header = input.header ?? 'X-Request-Id'
  if (!TOKEN.test(header)) throw new UsageError('--header must be a valid HTTP header name')

  const waitMs = input.waitMs ?? 500
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new UsageError(`--wait must be an integer between 0 and ${MAX_WAIT_MS}`)
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new UsageError(`--timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
  }

  return {
    origin: target.origin,
    protocol: target.protocol,
    paths: [...new Set(paths)],
    log: input.log ?? null,
    header,
    headerKey: header.toLowerCase(),
    waitMs,
    timeoutMs,
    remote: !isLoopbackHost(target.hostname),
    version: input.version
  }
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP probes

function withMarker (path, marker) {
  return `${path}${path.includes('?') ? '&' : '?'}${MARKER_QUERY_PARAM}=${marker}`
}

/**
 * One GET request. Resolves with the outcome; never rejects.
 * timeoutMs is a hard deadline for the whole exchange, not an idle timeout: a server that keeps sending a
 * trickle of bytes must not be able to hold doctor open indefinitely.
 */
function sendProbe (options, { name, path, extraHeaders = {} }, markers) {
  const client = options.protocol === 'https:' ? https : http
  const url = new URL(withMarker(path, markers.query), options.origin)
  const headers = {
    'User-Agent': `express-observe-doctor/${options.version}`,
    [MARKER_HEADER]: markers.header,
    Accept: '*/*',
    ...extraHeaders
  }
  return new Promise((resolve) => {
    let settled = false
    let deadline = null
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve({ name, path, ...result })
    }
    // Once headers have arrived the probe has what it needs; an early end of the body (size cap, deadline,
    // server reset) only marks it as truncated.
    let response = null
    const finish = (truncated) => done({ ok: true, status: response.statusCode, headers: response.headers, truncated })
    const req = client.request(url, { method: 'GET', headers, agent: false }, (res) => {
      response = res
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) res.destroy()
      })
      res.on('end', () => finish(false))
      res.on('close', () => finish(!res.complete))
      res.on('error', () => finish(true))
    })
    deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), options.timeoutMs)
    req.on('error', (err) => {
      if (response !== null) finish(true)
      else done({ ok: false, error: err.code || err.message })
    })
    req.end()
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Server-Timing validation (W3C grammar, strict)

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
  return parts
}

function parseServerTiming (value) {
  const metrics = []
  for (const metric of splitOutsideQuotes(value, ',')) {
    if (metric === '') continue
    const [name, ...params] = splitOutsideQuotes(metric, ';')
    if (!TOKEN.test(name)) return { ok: false, error: `invalid metric name ${JSON.stringify(name)}` }
    let dur
    for (const param of params) {
      const eq = param.indexOf('=')
      const key = (eq === -1 ? param : param.slice(0, eq)).trim()
      const val = eq === -1 ? '' : param.slice(eq + 1).trim()
      if (!TOKEN.test(key) || (eq !== -1 && !TOKEN.test(val) && !QUOTED.test(val))) {
        return { ok: false, error: `invalid parameter in metric ${JSON.stringify(name)}` }
      }
      if (key.toLowerCase() === 'dur') {
        if (!/^\d+(\.\d+)?$/.test(val)) return { ok: false, error: `non-numeric dur in metric ${JSON.stringify(name)}` }
        dur = Number(val)
      }
    }
    metrics.push({ name, dur })
  }
  return { ok: true, metrics }
}

// ---------------------------------------------------------------------------------------------------------------
// Log reading (read-only; contents are never printed)

async function readLog (file, requestIds, markers) {
  const counts = new Map([...requestIds].map((id) => [id, 0]))
  const records = new Map()
  let markerHits = 0
  let streamError = null
  const input = fs.createReadStream(file)
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  input.once('error', (err) => {
    streamError = err
    rl.close()
  })
  for await (const line of rl) {
    if (line.includes(markers.query) || line.includes(markers.header)) markerHits++
    let id = null
    for (const candidate of requestIds) {
      if (line.includes(candidate)) {
        id = candidate
        break
      }
    }
    if (id === null) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const result = classifyRecord(value)
    if (result.record && result.record.requestId === id) {
      counts.set(id, counts.get(id) + 1)
      if (!records.has(id)) records.set(id, result.record)
    }
  }
  if (streamError !== null) throw streamError
  return { counts, records, markerHits }
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

const RANK = { pass: 0, info: 0, skip: 0, warn: 1, fail: 2 }

function check (id, title) {
  const c = { id, title, status: 'pass', summary: '', details: [] }
  c.worse = (status, detail) => {
    if (RANK[status] > RANK[c.status] || (c.status === 'pass' && status === 'info')) c.status = status
    if (detail) c.details.push(detail)
  }
  return c
}

function label (probe) {
  return `GET ${probe.path}`
}

function evaluate (options, probes, log) {
  const checks = []
  const answered = probes.filter((p) => p.ok)

  // reachable
  const reachable = check('reachable', 'server answers')
  for (const p of probes) {
    if (!p.ok) reachable.worse('fail', `${label(p)}: no HTTP response (${p.error})`)
    else if (p.status >= 500) reachable.worse('warn', `${label(p)}: answered ${p.status}`)
  }
  reachable.summary = `${answered.length} of ${probes.length} probes answered`
  checks.push(reachable)

  if (answered.length === 0) {
    // Nothing to inspect: report every other check as skipped rather than as a vacuous pass.
    const rest = ['request-id-header', 'request-id-unique', 'client-id-policy', 'server-timing', 'not-found-path',
      'log-record-count', 'route-label', 'privacy-markers']
    for (const id of rest) {
      const c = check(id, id)
      c.status = 'skip'
      c.summary = 'no response to check'
      checks.push(c)
    }
    return checks
  }

  // request-id-header
  const idHeader = check('request-id-header', `${options.header} on every response`)
  for (const p of answered) {
    const value = p.headers[options.headerKey]
    if (typeof value !== 'string') {
      idHeader.worse('fail', `${label(p)}: no ${options.header}. observe() does not run for this path, or a middleware registered before it answered.`)
    } else if (!VALID_ID.test(value)) {
      idHeader.worse('fail', `${label(p)}: ${options.header} is not a valid ID (${options.header} may be set by something else)`)
    }
  }
  idHeader.summary = idHeader.status === 'pass' ? `present and valid on ${answered.length} response(s)` : 'missing or invalid on some responses'
  checks.push(idHeader)

  // request-id-unique (the client-ID probe is excluded: it may legitimately echo the ID it sent)
  const unique = check('request-id-unique', 'a new ID per request')
  const seen = new Map()
  for (const p of answered.filter((x) => x.name !== 'client-id')) {
    const id = p.headers[options.headerKey]
    if (typeof id !== 'string') continue
    if (seen.has(id)) unique.worse('fail', `${label(seen.get(id))} and ${label(p)} returned the same ID. A cache or another middleware may be replaying responses or headers.`)
    else seen.set(id, p)
  }
  unique.summary = unique.status === 'pass' ? `${seen.size} distinct ID(s)` : 'IDs repeat across requests'
  checks.push(unique)

  // client-id-policy (information only)
  const policy = check('client-id-policy', 'client-supplied request IDs')
  const clientProbe = probes.find((p) => p.name === 'client-id')
  if (clientProbe && clientProbe.ok && typeof clientProbe.headers[options.headerKey] === 'string') {
    const accepted = clientProbe.headers[options.headerKey] === clientProbe.sentId
    policy.status = 'info'
    policy.summary = accepted
      ? 'accepted: this client can choose the ID that appears in logs (requestId.trustIncoming allows it)'
      : 'not accepted: the server generated its own ID (the default)'
  } else {
    policy.status = 'skip'
    policy.summary = 'could not be determined'
  }
  checks.push(policy)

  // server-timing
  const timing = check('server-timing', 'Server-Timing header')
  for (const p of answered) {
    const value = p.headers['server-timing']
    if (typeof value !== 'string') {
      timing.worse('warn', `${label(p)}: no Server-Timing (serverTiming disabled, or observe() not on this path)`)
      continue
    }
    const parsed = parseServerTiming(value)
    if (!parsed.ok) timing.worse('fail', `${label(p)}: malformed Server-Timing: ${parsed.error}`)
    else if (!parsed.metrics.some((m) => m.name === 'app' && m.dur !== undefined)) timing.worse('warn', `${label(p)}: no app;dur entry`)
  }
  timing.summary = timing.status === 'pass' ? `well-formed with an app entry on ${answered.length} response(s)` : 'missing or malformed on some responses'
  checks.push(timing)

  // not-found-path
  const notFound = check('not-found-path', 'unmatched paths are observed too')
  const nf = probes.find((p) => p.name === 'not-found')
  if (!nf || !nf.ok) {
    notFound.status = 'skip'
    notFound.summary = 'probe got no response'
  } else if (typeof nf.headers[options.headerKey] !== 'string') {
    notFound.worse('fail', `${label(nf)}: answered ${nf.status} without ${options.header}. observe() is probably mounted on a sub-path or after a catch-all handler.`)
    notFound.summary = 'unmatched requests are not observed'
  } else {
    notFound.summary = `answered ${nf.status} with ${options.header}`
  }
  checks.push(notFound)

  // log-based checks
  const logChecks = [
    check('log-record-count', 'exactly one log record per request'),
    check('route-label', 'route labels are templates'),
    check('privacy-markers', 'query strings and headers stay out of the log')
  ]
  if (log === null) {
    for (const c of logChecks) {
      c.status = 'skip'
      c.summary = 'needs --log <file>'
    }
    checks.push(...logChecks)
    return checks
  }
  if (log.error) {
    for (const c of logChecks) {
      c.status = 'fail'
      c.summary = `cannot read the log file (${log.error})`
    }
    checks.push(...logChecks)
    return checks
  }

  const [count, route, privacy] = logChecks
  let correlated = 0
  for (const p of answered) {
    const id = p.headers[options.headerKey]
    if (typeof id !== 'string' || !log.counts.has(id)) continue
    correlated++
    const n = log.counts.get(id)
    if (n === 0) count.worse('fail', `${label(p)} (${safe(id)}): no record. Logging may be disabled, written to another file, or not flushed within --wait.`)
    if (n > 1) count.worse('fail', `${label(p)} (${safe(id)}): ${n} records. Two sinks or loggers write the same record.`)
  }
  count.summary = correlated === 0 ? 'no probe could be correlated' : count.status === 'pass' ? `${correlated} request(s), one record each` : 'missing or duplicate records'
  if (correlated === 0) count.status = 'skip'
  checks.push(count)

  for (const p of answered) {
    const id = p.headers[options.headerKey]
    const record = typeof id === 'string' ? log.records.get(id) : undefined
    if (!record) continue
    if (p.name === 'not-found') {
      if (record.route !== null && record.route.includes(p.randomSegment)) {
        route.worse('fail', `${label(p)}: the record's route contains the requested path. A raw URL is being logged as the route.`)
      }
      continue
    }
    if (record.route === null && p.status < 400) {
      route.worse('warn', `${label(p)}: answered ${p.status} but the route is null. If a router serves it, add the router's mount template to route.mounts; if a middleware answered, set res.locals.observeRoute.`)
    } else if (record.route !== null) {
      const pathname = new URL(p.path, 'http://x').pathname
      if (record.route === pathname && pathname.split('/').some((s) => ID_LIKE_SEGMENT.test(s))) {
        route.worse('warn', `${label(p)}: the route equals the concrete path ${safe(pathname)}. If that path has parameters, an explicit label or resolver may be returning the raw URL.`)
      }
    }
  }
  route.summary = route.status === 'pass' ? 'no raw paths or unexplained null routes' : 'see details'
  checks.push(route)

  if (log.markerHits > 0) {
    privacy.worse('fail', `the random markers sent in the query string and in ${MARKER_HEADER} appear in ${log.markerHits} log line(s). Something (log.extend, another logger, a proxy log) writes query strings or headers into this file.`)
    privacy.summary = 'request data leaks into the log'
  } else {
    privacy.summary = 'markers not found in the log'
  }
  checks.push(privacy)
  return checks
}

// ---------------------------------------------------------------------------------------------------------------
// Run

async function runDoctor (input) {
  const options = validateOptions(input)
  const markers = { query: `eoq${randomBytes(8).toString('hex')}`, header: `eoh${randomBytes(8).toString('hex')}` }

  const plan = []
  for (const path of options.paths) {
    plan.push({ name: 'path', path })
    plan.push({ name: 'path', path })
  }
  const sentId = `doctor-${randomBytes(8).toString('hex')}`
  plan.push({ name: 'client-id', path: options.paths[0], extraHeaders: { [options.header]: sentId }, sentId })
  const randomSegment = `express-observe-doctor-${randomBytes(6).toString('hex')}`
  plan.push({ name: 'not-found', path: `/${randomSegment}`, randomSegment })

  const probes = []
  for (const step of plan) {
    const result = await sendProbe(options, step, markers)
    probes.push({ ...result, sentId: step.sentId, randomSegment: step.randomSegment })
    // A refused connection will not succeed for the next probe either: stop early instead of retrying.
    if (!result.ok && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(result.error)) break
  }

  let log = null
  if (options.log !== null) {
    await new Promise((resolve) => setTimeout(resolve, options.waitMs))
    const ids = new Set(probes.filter((p) => p.ok && typeof p.headers[options.headerKey] === 'string').map((p) => p.headers[options.headerKey]))
    try {
      log = await readLog(options.log, ids, markers)
    } catch (err) {
      log = { error: err.code === 'ENOENT' ? 'no such file' : err.code === 'EISDIR' ? 'is a directory' : (err.code || 'read error') }
    }
  }

  const checks = evaluate(options, probes, log).map(({ worse, ...rest }) => rest)
  return {
    reportVersion: REPORT_VERSION,
    target: options.origin,
    remote: options.remote,
    requests: probes.length,
    log: options.log === null ? null : { file: options.log, waitMs: options.waitMs },
    probes: probes.map((p) => ({
      name: p.name,
      path: p.path,
      status: p.ok ? p.status : null,
      error: p.ok ? null : p.error,
      requestId: p.ok && typeof p.headers[options.headerKey] === 'string' ? p.headers[options.headerKey] : null,
      bodyTruncated: p.ok ? p.truncated === true : null
    })),
    checks,
    failures: checks.filter((c) => c.status === 'fail').length,
    warnings: checks.filter((c) => c.status === 'warn').length
  }
}

function renderDoctorText (report) {
  const out = []
  const logText = report.log ? `, log: ${safe(report.log.file)}` : ', no --log (log checks skipped)'
  out.push(`express-observe doctor: ${safe(report.target)} (${report.requests} GET requests${logText})`)
  if (report.remote) out.push('Warning: the target is not a loopback address (--allow-remote).')
  out.push('')
  const width = Math.max(...report.checks.map((c) => c.id.length))
  for (const c of report.checks) {
    out.push(`${c.status.toUpperCase().padEnd(4)}  ${c.id.padEnd(width)}  ${safe(c.summary)}`)
    for (const d of c.details) out.push(`${' '.repeat(width + 8)}- ${safe(d)}`)
  }
  out.push('')
  out.push(`Result: ${report.failures} failure(s), ${report.warnings} warning(s).`)
  out.push('Doctor\'s own requests appear in your logs with User-Agent express-observe-doctor.')
  return out.join('\n') + '\n'
}

module.exports = {
  REPORT_VERSION,
  DEFAULT_TIMEOUT_MS,
  MAX_PATHS,
  UsageError,
  isLoopbackHost,
  validateOptions,
  parseServerTiming,
  runDoctor,
  renderDoctorText
}
