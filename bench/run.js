'use strict'

// Overhead benchmark for express-observe. See bench/README.md for method and caveats.
//
//   node run.js [--duration=15] [--warmup=5] [--connections=50] [--rounds=3]
//               [--variants=baseline,ids-timing,full-log,pino-http] [--handler=tiny|work] [--out=results]
//
// Every measured run gets a fresh server process. Variant order rotates each round to spread slow drift
// (thermal, background load) across variants. Raw results, a manifest and a summary are written to
// <out>/<date>-<time>/.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execSync } = require('node:child_process')
const autocannon = require('autocannon')

const ALL_VARIANTS = ['baseline', 'ids-timing', 'full-log', 'pino-http']
const LOGGING_VARIANTS = new Set(['full-log', 'pino-http'])
const PATH = '/users/42'
// Must match the handlers in server.js.
const HANDLERS = {
  tiny: 'a small JSON body, returned at once',
  work: 'about 3 KB of JSON after a fixed amount of CPU work (about 0.27 ms)'
}
const KNOWN_ARGS = ['duration', 'warmup', 'connections', 'rounds', 'variants', 'handler', 'out']

// ---------------------------------------------------------------------------------------------------------------
// Configuration

function parseArgs (argv) {
  const args = Object.fromEntries(argv.map((a) => {
    const m = /^--([a-z-]+)=(.*)$/.exec(a)
    if (!m || !KNOWN_ARGS.includes(m[1])) throw new Error(`unrecognised argument ${a}`)
    return [m[1], m[2]]
  }))
  const int = (name, fallback) => {
    const v = args[name] === undefined ? fallback : Number(args[name])
    if (!Number.isInteger(v) || v <= 0) throw new Error(`--${name} must be a positive integer`)
    return v
  }
  const variants = (args.variants ?? ALL_VARIANTS.join(',')).split(',')
  for (const v of variants) if (!ALL_VARIANTS.includes(v)) throw new Error(`unknown variant ${v}`)
  const handler = args.handler ?? 'tiny'
  if (!Object.hasOwn(HANDLERS, handler)) throw new Error('--handler must be tiny or work')
  return {
    handler,
    durationSec: int('duration', 15),
    warmupSec: int('warmup', 5),
    connections: int('connections', 50),
    rounds: int('rounds', 3),
    pipelining: 1,
    variants,
    out: path.resolve(__dirname, args.out ?? 'results')
  }
}

function tryExec (cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function environment () {
  const cpus = os.cpus()
  const pkgVersion = (name) => require(`${name}/package.json`).version
  return {
    date: new Date().toISOString(),
    nodeVersion: process.version,
    expressVersion: pkgVersion('express'),
    expressObserveVersion: pkgVersion('express-observe'),
    autocannonVersion: pkgVersion('autocannon'),
    pinoHttpVersion: pkgVersion('pino-http'),
    pinoVersion: require(require.resolve('pino/package.json', { paths: [path.dirname(require.resolve('pino-http'))] })).version,
    os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    osVersion: typeof os.version === 'function' ? os.version() : null,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    logicalCpus: cpus.length,
    totalMemGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    // chcp 65001: make powercfg print the localized plan name as UTF-8 instead of the console code page.
    powerPlan: process.platform === 'win32' ? tryExec('chcp 65001 >nul && powercfg /getactivescheme') : null,
    sourceCommit: tryExec('git rev-parse --short HEAD') ?? 'uncommitted working tree',
    workingTreeDirty: (tryExec('git status --porcelain') ?? '').length > 0
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Server process

function startServer (variant, handler, logPath, extraEnv = {}) {
  const logFd = fs.openSync(logPath, 'w')
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), variant, handler], {
    cwd: __dirname,
    stdio: ['ignore', logFd, 'inherit', 'ipc'],
    env: { ...process.env, NODE_ENV: 'production', ...extraEnv }
  })
  fs.closeSync(logFd)

  const request = (type, replyType) => new Promise((resolve) => {
    const onMessage = (msg) => {
      if (msg.type === replyType) {
        child.off('message', onMessage)
        resolve(msg)
      }
    }
    child.on('message', onMessage)
    if (type) child.send({ type })
  })

  const ready = request(null, 'ready')
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return {
    ready,
    mark: () => request('mark', 'marked'),
    stats: () => request('stats', 'stats'),
    stop: async () => {
      child.disconnect()
      const timer = setTimeout(() => child.kill(), 3000)
      await exited
      clearTimeout(timer)
    }
  }
}

function getOnce (port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: PATH, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    }).on('error', reject)
  })
}

function runAutocannon (opts, onResponse) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => (err ? reject(err) : resolve(result)))
    if (onResponse) instance.on('response', onResponse)
  })
}

async function countLines (file) {
  let lines = 0
  for await (const chunk of fs.createReadStream(file)) {
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) lines++
  }
  return lines
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics

/** Nearest-rank percentile on a sorted array. */
function percentile (sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

function median (values) {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const r2 = (n) => (n === null ? null : Math.round(n * 100) / 100)

// ---------------------------------------------------------------------------------------------------------------
// One measured run

async function measure (variant, round, config, tmpDir, extraEnv = {}) {
  const logPath = path.join(tmpDir, `${variant}-r${round}.log`)
  // ab.js passes its own config without a handler: it measures the tiny handler.
  const server = startServer(variant, config.handler ?? 'tiny', logPath, extraEnv)
  const { port } = await server.ready
  const url = `http://127.0.0.1:${port}${PATH}`
  const problems = []

  try {
    // Correctness smoke check: the variant is configured as intended.
    const smoke = await getOnce(port)
    const hasId = typeof smoke.headers['x-request-id'] === 'string'
    const hasTiming = typeof smoke.headers['server-timing'] === 'string'
    const expectId = variant !== 'baseline'
    const expectTiming = variant === 'ids-timing' || variant === 'full-log'
    if (smoke.status !== 200) problems.push(`smoke request returned ${smoke.status}`)
    if (hasId !== expectId) problems.push(`X-Request-Id ${hasId ? 'present' : 'missing'} unexpectedly`)
    if (hasTiming !== expectTiming) problems.push(`Server-Timing ${hasTiming ? 'present' : 'missing'} unexpectedly`)

    await runAutocannon({ url, connections: config.connections, duration: config.warmupSec, pipelining: config.pipelining })
    await server.mark()

    const latencies = []
    const result = await runAutocannon(
      { url, connections: config.connections, duration: config.durationSec, pipelining: config.pipelining },
      (_client, _status, _bytes, responseTime) => latencies.push(responseTime)
    )
    const stats = await server.stats()
    await server.stop()

    const logBytes = fs.statSync(logPath).size
    const logLines = await countLines(logPath)
    fs.rmSync(logPath, { force: true })

    if (result.errors > 0) problems.push(`${result.errors} connection errors`)
    if (result.timeouts > 0) problems.push(`${result.timeouts} timeouts`)
    if (result.non2xx > 0) problems.push(`${result.non2xx} non-2xx responses`)
    const expectedLines = LOGGING_VARIANTS.has(variant) ? stats.requestsTotal : 0
    if (logLines !== expectedLines) problems.push(`log lines ${logLines}, expected ${expectedLines}`)

    latencies.sort((a, b) => a - b)
    const measuredRequests = result.requests.total
    return {
      variant,
      round,
      startedAt: result.start,
      finishedAt: result.finish,
      problems,
      smoke: { status: smoke.status, xRequestId: hasId, serverTiming: hasTiming },
      fromResponseEvents: {
        samples: latencies.length,
        latencyMs: {
          p50: r2(percentile(latencies, 50)),
          p90: r2(percentile(latencies, 90)),
          p95: r2(percentile(latencies, 95)),
          p99: r2(percentile(latencies, 99)),
          p99_9: r2(percentile(latencies, 99.9)),
          max: r2(latencies.at(-1) ?? null)
        }
      },
      throughput: {
        requestsPerSecMean: r2(result.requests.average),
        requestsTotal: measuredRequests
      },
      server: {
        ...stats,
        cpuMsPer1kRequests: r2((stats.cpuUserMs + stats.cpuSystemMs) / (stats.requestsMeasured / 1000)),
        maxRssMb: r2(stats.maxRssKb / 1024)
      },
      log: {
        bytes: logBytes,
        lines: logLines,
        bytesPerLine: logLines > 0 ? r2(logBytes / logLines) : 0
      },
      autocannon: result
    }
  } catch (err) {
    await server.stop().catch(() => {})
    throw err
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting

function summarize (runs, variants) {
  const rows = variants.map((variant) => {
    const rs = runs.filter((r) => r.variant === variant)
    const pick = (fn) => rs.map(fn)
    const stat = (fn) => {
      const v = pick(fn)
      return { median: r2(median(v)), min: r2(Math.min(...v)), max: r2(Math.max(...v)) }
    }
    return {
      variant,
      runs: rs.length,
      problems: rs.flatMap((r) => r.problems.map((p) => `round ${r.round}: ${p}`)),
      rps: stat((r) => r.throughput.requestsPerSecMean),
      p50: stat((r) => r.fromResponseEvents.latencyMs.p50),
      p95: stat((r) => r.fromResponseEvents.latencyMs.p95),
      p99: stat((r) => r.fromResponseEvents.latencyMs.p99),
      cpuPer1k: stat((r) => r.server.cpuMsPer1kRequests),
      maxRssMb: stat((r) => r.server.maxRssMb),
      logBytesPerLine: stat((r) => r.log.bytesPerLine)
    }
  })
  const base = rows.find((r) => r.variant === 'baseline')
  for (const row of rows) {
    row.rpsVsBaselinePct = base ? r2((row.rps.median / base.rps.median - 1) * 100) : null
    row.p99VsBaselinePct = base ? r2((row.p99.median / base.p99.median - 1) * 100) : null
  }
  return rows
}

function fmt (s) {
  return `${s.median} (${s.min}–${s.max})`
}

function summaryMarkdown (env, config, rows, sessionId) {
  const lines = []
  lines.push(`# Benchmark ${sessionId}`)
  lines.push('')
  lines.push(`${config.rounds} independent runs per variant, ${config.connections} connections, ${config.durationSec} s measured after ${config.warmupSec} s warm-up, pipelining ${config.pipelining}, \`GET ${PATH}\` returning ${HANDLERS[config.handler]} (handler \`${config.handler}\`). Each cell is the **median of the per-run values, with the min–max range across runs**. Percentiles are computed per run from every response time and are never averaged across runs.`)
  lines.push('')
  lines.push('| Variant | req/s | vs baseline | p50 ms | p95 ms | p99 ms | p99 vs baseline | server CPU ms / 1k req | max RSS MB | log bytes / line |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(`| ${r.variant} | ${fmt(r.rps)} | ${r.rpsVsBaselinePct}% | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.p99VsBaselinePct}% | ${fmt(r.cpuPer1k)} | ${fmt(r.maxRssMb)} | ${r.logBytesPerLine.median} |`)
  }
  lines.push('')
  const problems = rows.flatMap((r) => r.problems.map((p) => `- ${r.variant}, ${p}`))
  lines.push('## Correctness checks')
  lines.push('')
  lines.push(problems.length === 0
    ? 'All runs: no connection errors, timeouts or non-2xx responses; expected headers present per variant; log line count equal to the number of requests the server handled (0 for non-logging variants).'
    : problems.join('\n'))
  lines.push('')
  lines.push('## Environment')
  lines.push('')
  lines.push('```text')
  for (const [k, v] of Object.entries(env)) lines.push(`${k}: ${v}`)
  lines.push('```')
  lines.push('')
  lines.push('## Caveats')
  lines.push('')
  lines.push('- Load generator and server share one machine; autocannon is single-threaded and competes for CPU. Absolute numbers describe this machine only.')
  lines.push('- Logs went to a file through the server process\'s stdout. Both the default sink and pino write synchronously in that setup. A pipe, a terminal or a remote collector behave differently.')
  lines.push(config.handler === 'tiny'
    ? '- The handler does almost nothing, so middleware cost is a large share of each request. In a real application the relative overhead is smaller; the absolute cost per request is the more transferable number.'
    : '- The handler does a fixed amount of synchronous CPU work (about 0.27 ms) and returns about 3 KB of JSON. Real handlers also wait on I/O, which costs no CPU but holds connections; this handler does not model that.')
  lines.push('- The pino-http variant is configured to be comparable, not identical: it has no Server-Timing and no route templates, and it uses its own serializers.')
  lines.push('- Background activity on the machine was not controlled. The min–max ranges show run-to-run spread.')
  return lines.join('\n') + '\n'
}

function manifestMarkdown (env, config, runs, sessionId) {
  const lines = []
  lines.push(`# Run manifest — ${sessionId}`)
  lines.push('')
  lines.push('One manifest for the whole session: every run shares the environment below. Fields follow bench/results/MANIFEST_TEMPLATE.md.')
  lines.push('')
  lines.push('```text')
  lines.push(`runId: ${sessionId}`)
  lines.push(`scenarioId: ${config.variants.join(', ')}`)
  lines.push('experimentType: overhead measurement')
  lines.push(`date: ${env.date}`)
  lines.push(`sourceCommit: ${env.sourceCommit}${env.workingTreeDirty ? ' (dirty)' : ''}`)
  lines.push(`nodeVersion: ${env.nodeVersion}`)
  lines.push(`expressVersion: ${env.expressVersion}`)
  lines.push(`expressObserveVersion: ${env.expressObserveVersion}`)
  lines.push(`osVersion: ${env.os}${env.osVersion ? ` / ${env.osVersion}` : ''}`)
  lines.push(`hardware: ${env.cpuModel}, ${env.logicalCpus} logical CPUs, ${env.totalMemGb} GB RAM`)
  lines.push(`powerState: ${env.powerPlan ?? 'not recorded'}`)
  lines.push(`loadTool/version: autocannon ${env.autocannonVersion}`)
  lines.push(`loadConfig: ${config.connections} connections, ${config.durationSec} s measured, ${config.warmupSec} s warm-up, pipelining ${config.pipelining}, GET ${PATH}, handler ${config.handler}`)
  lines.push('sinkDestination: server stdout redirected to a local temp file (deleted after counting)')
  lines.push('clientPlatform: node-script (autocannon in the parent process)')
  lines.push('networkCondition: loopback 127.0.0.1')
  lines.push(`repetitions: ${config.rounds} per variant, fresh server process per run, variant order rotated per round`)
  lines.push('changedVariable: middleware configuration (variant)')
  lines.push(`correctnessResult: ${runs.every((r) => r.problems.length === 0) ? 'all checks passed' : 'see summary.md'}`)
  lines.push('rawEvidencePaths: runs/*.json (full autocannon result per run, plus server stats and log counts)')
  lines.push('knownBlindSpots: shared machine for client and server; background load not controlled; tiny handler exaggerates relative overhead; no pipe or network log destination tested')
  lines.push('```')
  lines.push('')
  lines.push('| Run | Variant | Round | Started | Problems |')
  lines.push('|---|---|---|---|---|')
  runs.forEach((r, i) => lines.push(`| ${i + 1} | ${r.variant} | ${r.round} | ${new Date(r.startedAt).toISOString()} | ${r.problems.length === 0 ? 'none' : r.problems.join('; ')} |`))
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------------------------

async function main () {
  const config = parseArgs(process.argv.slice(2))
  const env = environment()
  const now = new Date()
  const sessionId = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, '')}`
  const sessionDir = path.join(config.out, sessionId)
  const runsDir = path.join(sessionDir, 'runs')
  fs.mkdirSync(runsDir, { recursive: true })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'express-observe-bench-'))

  const total = config.rounds * config.variants.length
  process.stderr.write(`benchmark ${sessionId}: ${total} runs, about ${Math.ceil(total * (config.durationSec + config.warmupSec + 2) / 60)} min\n`)

  const runs = []
  try {
    for (let round = 1; round <= config.rounds; round++) {
      const shift = (round - 1) % config.variants.length
      const order = [...config.variants.slice(shift), ...config.variants.slice(0, shift)]
      for (const variant of order) {
        const run = await measure(variant, round, config, tmpDir)
        runs.push(run)
        fs.writeFileSync(path.join(runsDir, `r${round}-${variant}.json`), JSON.stringify({ environment: env, config, ...run }, null, 2))
        process.stderr.write(`  round ${round} ${variant.padEnd(10)} ${run.throughput.requestsPerSecMean} req/s  p50 ${run.fromResponseEvents.latencyMs.p50} p95 ${run.fromResponseEvents.latencyMs.p95} p99 ${run.fromResponseEvents.latencyMs.p99} ms${run.problems.length ? `  PROBLEMS: ${run.problems.join('; ')}` : ''}\n`)
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  const rows = summarize(runs, config.variants)
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify({ environment: env, config, rows }, null, 2))
  fs.writeFileSync(path.join(sessionDir, 'summary.md'), summaryMarkdown(env, config, rows, sessionId))
  fs.writeFileSync(path.join(sessionDir, 'manifest.md'), manifestMarkdown(env, config, runs, sessionId))
  process.stdout.write(summaryMarkdown(env, config, rows, sessionId))
  if (runs.some((r) => r.problems.length > 0)) process.exitCode = 1
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`benchmark failed: ${err && err.stack}\n`)
    process.exitCode = 1
  })
}

module.exports = { measure, median, environment }
