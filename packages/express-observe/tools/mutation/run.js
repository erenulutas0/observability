#!/usr/bin/env node
'use strict'

// Hand-picked mutation checks: does the test suite notice when a specific safeguard is removed?
//
//   node tools/mutation/run.js            run every spec in tools/mutation/specs
//   node tools/mutation/run.js doctor     run specs whose file name contains "doctor"
//
// For each mutation the target text must occur exactly once in its file, otherwise the mutation is reported as
// NOT APPLIED (the spec is stale). The file is restored after every run, also when the runner is interrupted.
// A mutation is CAUGHT when the tests fail or time out, SURVIVED when they pass. Mutations marked `equivalent`
// (no observable behaviour change, with a reason) are expected to survive and do not fail the run.
//
// This is not a general mutation-testing tool. It documents and re-checks the specific breakages that were
// tried by hand during development.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PACKAGE_DIR = path.resolve(__dirname, '..', '..')
const SPECS_DIR = path.join(__dirname, 'specs')
const TEST_TIMEOUT_MS = 240_000

const originals = new Map()
function restoreAll () {
  for (const [file, content] of originals) fs.writeFileSync(file, content)
  originals.clear()
}
process.on('SIGINT', () => { restoreAll(); process.exit(130) })
process.on('exit', restoreAll)

function runTests (testFiles) {
  const jest = require.resolve('jest/bin/jest', { paths: [PACKAGE_DIR] })
  const result = spawnSync(process.execPath, [jest, ...testFiles, '--forceExit'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    env: { ...process.env, CI: 'true' }
  })
  const summary = ((result.stdout || '') + (result.stderr || '')).match(/^Tests:.*$/m)
  if (result.error && result.error.code === 'ETIMEDOUT') return { failed: true, summary: 'timed out' }
  return { failed: result.status !== 0, summary: summary ? summary[0].replace(/^Tests:\s+/, '') : `exit ${result.status}` }
}

function runSpec (specFile) {
  const spec = require(specFile)
  const rows = []
  for (const m of spec.mutations) {
    const file = path.join(PACKAGE_DIR, m.file)
    const original = fs.readFileSync(file, 'utf8')
    const occurrences = original.split(m.from).length - 1
    if (occurrences !== 1) {
      rows.push({ name: m.name, outcome: 'NOT APPLIED', detail: `target text found ${occurrences} times in ${m.file}` })
      continue
    }
    originals.set(file, original)
    fs.writeFileSync(file, original.replace(m.from, m.to))
    let result
    try {
      result = runTests(spec.tests)
    } finally {
      fs.writeFileSync(file, original)
      originals.delete(file)
    }
    let outcome = result.failed ? 'caught' : 'SURVIVED'
    if (m.equivalent) outcome = result.failed ? 'caught (expected to survive)' : 'survived (equivalent)'
    rows.push({ name: m.name, outcome, detail: result.summary, reason: m.equivalent })
  }
  return { spec, rows }
}

function main () {
  const filter = process.argv[2] || ''
  const specs = fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.js') && f.includes(filter)).sort()
  if (specs.length === 0) {
    process.stderr.write(`no spec matches "${filter}"\n`)
    process.exitCode = 2
    return
  }
  let bad = 0
  for (const name of specs) {
    const { spec, rows } = runSpec(path.join(SPECS_DIR, name))
    process.stdout.write(`\n## ${spec.title}\n\ntests: ${spec.tests.join(' ')}\n\n| Mutation | Outcome | Tests |\n|---|---|---|\n`)
    for (const r of rows) {
      process.stdout.write(`| ${r.name} | ${r.outcome} | ${r.detail}${r.reason ? ` — equivalent: ${r.reason}` : ''} |\n`)
      if (r.outcome === 'SURVIVED' || r.outcome === 'NOT APPLIED') bad++
    }
  }
  process.stdout.write(`\n${bad === 0 ? 'All non-equivalent mutations were caught.' : `${bad} mutation(s) survived or could not be applied.`}\n`)
  process.exitCode = bad === 0 ? 0 : 1
}

main()
