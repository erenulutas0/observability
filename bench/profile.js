'use strict'

// CPU profile of one benchmark variant under load. Explains where overhead goes; it is not a benchmark
// (profiling itself slows the server down).
//
//   node profile.js <variant> [--duration=10]
//
// Prints the top self-time functions overall and those belonging to express-observe, on-headers, on-finished
// and ee-first. The .cpuprofile file is written to a temp directory and its path printed, so it can be opened
// in Chrome DevTools.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const autocannon = require('autocannon')

const variant = process.argv[2]
const durationArg = process.argv.find((a) => a.startsWith('--duration='))
const duration = durationArg ? Number(durationArg.split('=')[1]) : 10
if (!variant) {
  process.stderr.write('usage: node profile.js <variant> [--duration=10]\n')
  process.exit(2)
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'express-observe-profile-'))
const profileName = `${variant}.cpuprofile`
const logPath = path.join(outDir, `${variant}.log`)
const logFd = fs.openSync(logPath, 'w')
const child = spawn(process.execPath, [
  '--cpu-prof', `--cpu-prof-dir=${outDir}`, `--cpu-prof-name=${profileName}`,
  path.join(__dirname, 'server.js'), variant
], { cwd: __dirname, stdio: ['ignore', logFd, 'inherit', 'ipc'], env: { ...process.env, NODE_ENV: 'production' } })
fs.closeSync(logFd)

child.on('message', async (msg) => {
  if (msg.type !== 'ready') return
  const url = `http://127.0.0.1:${msg.port}/users/42`
  await new Promise((resolve) => autocannon({ url, connections: 50, duration: 3 }, resolve))
  await new Promise((resolve) => autocannon({ url, connections: 50, duration }, resolve))
  child.disconnect()
})

child.on('exit', () => {
  fs.rmSync(logPath, { force: true })
  const profilePath = path.join(outDir, profileName)
  const prof = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
  const total = prof.nodes.reduce((sum, node) => sum + node.hitCount, 0)
  const byFunction = new Map()
  for (const node of prof.nodes) {
    const cf = node.callFrame
    const file = cf.url
      ? cf.url.replace(/^.*node_modules[\\/]/, '').replace(/^.*[\\/]packages[\\/]/, '').replace(/^file:\/+/, '')
      : ''
    const key = `${cf.functionName || '(anonymous)'}  ${file}${file ? `:${cf.lineNumber + 1}` : ''}`
    byFunction.set(key, (byFunction.get(key) ?? 0) + node.hitCount)
  }
  const pct = (hits) => `${(hits / total * 100).toFixed(2).padStart(6)}%`
  const isOurs = (key) => /express-observe|on-headers|on-finished|ee-first/.test(key)
  const ours = [...byFunction].filter(([key]) => isOurs(key)).sort((a, b) => b[1] - a[1])

  const lines = [`== ${variant}: ${total} samples, ${duration} s under load (50 connections)`, 'top 15 self time overall:']
  for (const [key, hits] of [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`${pct(hits)}  ${key}`)
  lines.push(`express-observe + on-headers + on-finished + ee-first self time: ${pct(ours.reduce((s, [, h]) => s + h, 0))}`)
  for (const [key, hits] of ours.slice(0, 15)) lines.push(`${pct(hits)}  ${key}`)
  lines.push(`profile: ${profilePath}`)
  process.stdout.write(lines.join('\n') + '\n\n')
})
