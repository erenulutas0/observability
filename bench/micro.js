'use strict'

// In-process microbenchmark of the middleware's own JavaScript cost: real http.IncomingMessage and
// http.ServerResponse objects on an in-memory socket, handled by a real Express app. No network, no kernel, no
// load generator, so run-to-run noise is far lower than in run.js. It does not replace run.js: it ignores socket
// I/O and log writes, and measures CPU per request, not latency.
//
//   node micro.js [--a-ref=main] [--variants=ids-timing,full-log] [--rounds=10] [--n=40000] [--same]
//
// A is the package at --a-ref (extracted like ab.js), B the working tree. Each measurement is a fresh child
// process that warms up, then reports CPU microseconds per request. A and B alternate within each round.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// ---------------------------------------------------------------------------------------------------------------
// Child mode: node micro.js --child <variant> <n>

async function child (variant, n) {
  const http = require('node:http')
  const { Duplex } = require('node:stream')
  const express = require('express')
  const observe = require(process.env.EXPRESS_OBSERVE_MODULE || 'express-observe')

  const app = express()
  app.disable('x-powered-by')
  app.disable('etag')
  // Logging variants serialize the record but discard the bytes: this measures record building, not I/O.
  const sink = (record) => { JSON.stringify(record) }
  if (variant === 'ids-timing') app.use(observe({ service: 'bench', log: { enabled: false } }))
  else if (variant === 'full-log') app.use(observe({ service: 'bench', release: '0.1.0-dev.0', log: { sink } }))
  else if (variant === 'full-log-eventloop') app.use(observe({ service: 'bench', release: '0.1.0-dev.0', log: { sink }, eventLoop: { enabled: true } }))
  else if (variant !== 'baseline') throw new Error(`unknown variant ${variant}`)
  app.get('/users/:id', (req, res) => res.json({ id: req.params.id, ok: true }))

  function oneRequest () {
    return new Promise((resolve, reject) => {
      const socket = new Duplex({ read () {}, write (chunk, enc, cb) { cb() } })
      socket.remoteAddress = '127.0.0.1'
      const req = new http.IncomingMessage(socket)
      req.method = 'GET'
      req.url = '/users/42'
      req.httpVersionMajor = 1
      req.httpVersionMinor = 1
      req.headers = { host: 'localhost', accept: '*/*' }
      req.complete = true
      req.push(null)
      const res = new http.ServerResponse(req)
      res.assignSocket(socket)
      res.on('finish', () => {
        // Detach but do not destroy: destroying a socket with buffered writes makes Node build an
        // ERR_STREAM_DESTROYED error per request, which would dominate the measurement.
        res.detachSocket(socket)
        resolve()
      })
      res.on('error', reject)
      app(req, res)
    })
  }

  async function batch (count) {
    const inflight = 32
    for (let i = 0; i < count; i += inflight) {
      const k = Math.min(inflight, count - i)
      const ps = new Array(k)
      for (let j = 0; j < k; j++) ps[j] = oneRequest()
      await Promise.all(ps)
    }
  }

  await batch(Math.max(5000, n / 4)) // warm-up: JIT and inline caches
  if (global.gc) global.gc()
  const cpu0 = process.cpuUsage()
  const t0 = process.hrtime.bigint()
  await batch(n)
  const cpu = process.cpuUsage(cpu0)
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6
  process.stdout.write(JSON.stringify({ cpuUsPerReq: (cpu.user + cpu.system) / n, wallUsPerReq: wallMs * 1000 / n }) + '\n')
}

// ---------------------------------------------------------------------------------------------------------------
// Runner mode

function parseArgs (argv) {
  const args = Object.fromEntries(argv.map((a) => {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m) throw new Error(`unrecognised argument ${a}`)
    return [m[1], m[2] ?? true]
  }))
  const ref = args['a-ref'] ?? 'main'
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error('--a-ref must be a plain git ref name')
  return {
    aRef: ref,
    same: args.same === true,
    variants: String(args.variants ?? 'ids-timing,full-log').split(','),
    rounds: Number(args.rounds ?? 10),
    n: Number(args.n ?? 40000)
  }
}

function extractRef (ref) {
  const repo = path.resolve(__dirname, '..')
  const target = path.join(__dirname, '.ab', ref.replace(/[^A-Za-z0-9._-]/g, '_'))
  fs.rmSync(target, { recursive: true, force: true })
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'packages/express-observe/src', 'packages/express-observe/package.json'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  for (const file of files) {
    const out = path.join(target, ...file.split('/'))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024 }))
  }
  const commit = execFileSync('git', ['rev-parse', '--short', ref], { cwd: repo, encoding: 'utf8' }).trim()
  return { dir: path.join(target, 'packages', 'express-observe'), commit }
}

function measureOnce (variant, n, moduleDir) {
  // Single-threaded GC: parallel GC helper threads add CPU time that varies from run to run.
  const out = execFileSync(process.execPath, ['--expose-gc', '--single-threaded-gc', __filename, '--child', variant, String(n)], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', EXPRESS_OBSERVE_MODULE: moduleDir }
  })
  return JSON.parse(out.trim().split('\n').pop())
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const r2 = (x) => Math.round(x * 100) / 100

function main () {
  const config = parseArgs(process.argv.slice(2))
  const a = extractRef(config.aRef)
  a.label = `${config.aRef} (${a.commit})`
  const b = config.same ? { ...a, label: `${a.label} again` } : { dir: path.resolve(__dirname, '..', 'packages', 'express-observe'), label: 'working tree' }
  process.stderr.write(`micro A/B: A = ${a.label}, B = ${b.label}, ${config.rounds} rounds x ${config.n} requests\n`)

  const results = []
  for (let round = 1; round <= config.rounds; round++) {
    for (const variant of config.variants) {
      const order = round % 2 === 1 ? [['A', a], ['B', b]] : [['B', b], ['A', a]]
      const pair = {}
      for (const [side, pkg] of order) pair[side] = measureOnce(variant, config.n, pkg.dir).cpuUsPerReq
      results.push({ round, variant, a: pair.A, b: pair.B })
      process.stderr.write(`  round ${round} ${variant.padEnd(10)} A ${r2(pair.A)} µs  B ${r2(pair.B)} µs\n`)
    }
  }

  const lines = [`micro A/B — A = ${a.label}, B = ${b.label}; ${config.rounds} rounds x ${config.n} requests; CPU µs per request, in-process, no I/O`, '',
    '| Variant | A | B | median paired diff | B lower in |', '|---|---|---|---|---|']
  for (const variant of config.variants) {
    const rs = results.filter((r) => r.variant === variant)
    const diffs = rs.map((r) => r.b - r.a)
    const aMed = median(rs.map((r) => r.a))
    lines.push(`| ${variant} | ${r2(aMed)} | ${r2(median(rs.map((r) => r.b)))} | ${r2(median(diffs))} µs (${r2(median(diffs) / aMed * 100)}%) | ${diffs.filter((d) => d < 0).length} of ${rs.length} |`)
  }
  process.stdout.write(lines.join('\n') + '\n')
}

if (process.argv[2] === '--child') {
  child(process.argv[3], Number(process.argv[4])).catch((err) => {
    process.stderr.write(`${err && err.stack}\n`)
    process.exitCode = 1
  })
} else {
  main()
}
