'use strict'

// A/B comparison of two versions of express-observe on the same machine, in the same session.
//
//   node ab.js [--a-ref=main] [--variants=ids-timing,full-log] [--rounds=6] [--duration=10] [--warmup=3]
//              [--connections=50] [--same]
//
// A is the package as committed at --a-ref (extracted with git archive into bench/.ab/, which git ignores).
// B is the package in the working tree. --same compares A with itself to measure the noise floor.
//
// Every run gets a fresh server process. Within each round the order alternates (A B, then B A) so that slow
// drift hits both sides equally. The primary metric is server CPU time per request, which is far less sensitive
// to other load on the machine than throughput. The verdict is a paired comparison: in how many rounds did B use
// less CPU than A, and what is the median of the per-round differences.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { measure, median, environment } = require('./run')

function parseArgs (argv) {
  const args = Object.fromEntries(argv.map((a) => {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m) throw new Error(`unrecognised argument ${a}`)
    return [m[1], m[2] ?? true]
  }))
  const int = (name, fallback) => {
    const v = args[name] === undefined ? fallback : Number(args[name])
    if (!Number.isInteger(v) || v <= 0) throw new Error(`--${name} must be a positive integer`)
    return v
  }
  const ref = args['a-ref'] ?? 'main'
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error('--a-ref must be a plain git ref name')
  return {
    aRef: ref,
    same: args.same === true,
    variants: String(args.variants ?? 'ids-timing,full-log').split(','),
    rounds: int('rounds', 6),
    durationSec: int('duration', 10),
    warmupSec: int('warmup', 3),
    connections: int('connections', 50),
    pipelining: 1
  }
}

/** Extract packages/express-observe at a git ref into bench/.ab/<ref>/ and return the package directory. */
function extractRef (ref) {
  const repo = path.resolve(__dirname, '..')
  const target = path.join(__dirname, '.ab', ref.replace(/[^A-Za-z0-9._-]/g, '_'))
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  // git show per file instead of git archive | tar: tar implementations disagree about Windows drive letters.
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'packages/express-observe/src', 'packages/express-observe/package.json'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  if (files.length === 0) throw new Error(`no package files at ${ref}`)
  for (const file of files) {
    const out = path.join(target, ...file.split('/'))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024 }))
  }
  const commit = execFileSync('git', ['rev-parse', '--short', ref], { cwd: repo, encoding: 'utf8' }).trim()
  return { dir: path.join(target, 'packages', 'express-observe'), commit }
}

const r2 = (n) => Math.round(n * 100) / 100

async function main () {
  const config = parseArgs(process.argv.slice(2))
  const env = environment()
  const a = extractRef(config.aRef)
  const b = config.same
    ? { ...a, label: `${config.aRef} (${a.commit}) again` }
    : { dir: path.resolve(__dirname, '..', 'packages', 'express-observe'), commit: `${env.sourceCommit}${env.workingTreeDirty ? '+dirty' : ''}`, label: 'working tree' }
  a.label = `${config.aRef} (${a.commit})`

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'express-observe-ab-'))
  const runs = []
  const total = config.rounds * config.variants.length * 2
  process.stderr.write(`A/B: A = ${a.label}, B = ${b.label}; ${total} runs, about ${Math.ceil(total * (config.durationSec + config.warmupSec + 2) / 60)} min\n`)
  try {
    for (let round = 1; round <= config.rounds; round++) {
      for (const variant of config.variants) {
        const order = round % 2 === 1 ? [['A', a], ['B', b]] : [['B', b], ['A', a]]
        for (const [side, pkg] of order) {
          const run = await measure(variant, round, config, tmpDir, { EXPRESS_OBSERVE_MODULE: pkg.dir })
          const cpuUsPerReq = run.server.cpuMsPer1kRequests
          runs.push({ side, variant, round, cpuUsPerReq, rps: run.throughput.requestsPerSecMean, p99: run.fromResponseEvents.latencyMs.p99, problems: run.problems })
          process.stderr.write(`  round ${round} ${variant.padEnd(10)} ${side}: ${cpuUsPerReq} µs CPU/req, ${run.throughput.requestsPerSecMean} req/s${run.problems.length ? `  PROBLEMS: ${run.problems.join('; ')}` : ''}\n`)
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  const rows = config.variants.map((variant) => {
    const pick = (side) => runs.filter((r) => r.variant === variant && r.side === side).sort((x, y) => x.round - y.round)
    const A = pick('A')
    const B = pick('B')
    const diffs = A.map((ra, i) => B[i].cpuUsPerReq - ra.cpuUsPerReq)
    const aMed = median(A.map((r) => r.cpuUsPerReq))
    return {
      variant,
      aCpuUsPerReq: r2(aMed),
      bCpuUsPerReq: r2(median(B.map((r) => r.cpuUsPerReq))),
      medianPairedDiffUs: r2(median(diffs)),
      medianPairedDiffPct: r2(median(diffs) / aMed * 100),
      roundsBLower: diffs.filter((d) => d < 0).length,
      rounds: diffs.length,
      aRps: r2(median(A.map((r) => r.rps))),
      bRps: r2(median(B.map((r) => r.rps))),
      problems: [...A, ...B].flatMap((r) => r.problems)
    }
  })

  const now = new Date().toISOString()
  const dir = path.join(__dirname, 'results', `ab-${now.slice(0, 10)}-${now.slice(11, 19).replace(/:/g, '')}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'ab.json'), JSON.stringify({ environment: env, config, a: { label: a.label }, b: { label: b.label }, rows, runs }, null, 2))

  const lines = [
    `# A/B ${path.basename(dir)}`,
    '',
    `A = ${a.label}, B = ${b.label}. ${config.rounds} rounds, alternating order, ${config.connections} connections, ${config.durationSec} s measured after ${config.warmupSec} s warm-up, fresh server process per run.`,
    '',
    '| Variant | A µs CPU/req | B µs CPU/req | median paired diff | B lower in | A req/s | B req/s |',
    '|---|---|---|---|---|---|---|'
  ]
  for (const r of rows) {
    lines.push(`| ${r.variant} | ${r.aCpuUsPerReq} | ${r.bCpuUsPerReq} | ${r.medianPairedDiffUs} µs (${r.medianPairedDiffPct}%) | ${r.roundsBLower} of ${r.rounds} rounds | ${r.aRps} | ${r.bRps} |`)
  }
  lines.push('')
  lines.push('Server CPU per request is the primary metric. A difference counts only if B is lower in every round (or higher in every round) and the median difference is larger than the spread seen in an A-vs-A run (`--same`).')
  const problems = rows.flatMap((r) => r.problems)
  lines.push('')
  lines.push(problems.length === 0 ? 'Correctness checks: all runs passed.' : `Correctness problems: ${problems.join('; ')}`)
  lines.push('')
  lines.push(`Environment: ${env.nodeVersion}, Express ${env.expressVersion}, ${env.os}, ${env.cpuModel}. Other load on the machine was not controlled.`)
  fs.writeFileSync(path.join(dir, 'ab.md'), lines.join('\n') + '\n')
  process.stdout.write(lines.join('\n') + '\n')
  if (problems.length > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`ab failed: ${err && err.stack}\n`)
  process.exitCode = 1
})
