#!/usr/bin/env node
'use strict'

// Installs the packed tarball into clean projects and uses it the way a consumer would: CommonJS JavaScript at
// runtime, TypeScript at compile time (correct usage must compile, misuse must not), and the CLI from node_modules.
// Catches what in-repo tests cannot: missing files in "files", a wrong "types" path, a broken bin, types that are
// too loose or too strict.
//
//   node tools/consumer/run.js            all profiles
//   node tools/consumer/run.js express5   profiles whose name contains "express5"
//
// Needs network access for npm install. Work happens in .consumer-test/ next to package.json (git-ignored).

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PACKAGE_DIR = path.resolve(__dirname, '..', '..')
const WORK_DIR = path.join(PACKAGE_DIR, '.consumer-test')
const FIXTURES = path.join(__dirname, 'fixtures')
const IS_WINDOWS = process.platform === 'win32'

const PROFILES = [
  { name: 'express4-typescript5', express: '4.22.3', typesExpress: '4.17.25', typescript: '5.9.3' },
  { name: 'express5-typescript7', express: '5.3.0', typesExpress: '5.0.6', typescript: '7.0.2' }
]

function run (cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: IS_WINDOWS && cmd !== process.execPath })
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}`.trim() }
}

function pack () {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  for (const f of fs.readdirSync(WORK_DIR)) if (f.endsWith('.tgz')) fs.rmSync(path.join(WORK_DIR, f))
  const r = run('npm', ['pack', '--pack-destination', WORK_DIR, '--json'], PACKAGE_DIR)
  if (!r.ok) throw new Error(`npm pack failed:\n${r.out}`)
  const tarball = fs.readdirSync(WORK_DIR).find((f) => f.endsWith('.tgz'))
  return path.join(WORK_DIR, tarball)
}

function setUpProject (profile, tarball) {
  const dir = path.join(WORK_DIR, profile.name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `consumer-${profile.name}`,
    private: true,
    dependencies: { 'express-observe': `file:${tarball.replace(/\\/g, '/')}`, express: profile.express },
    devDependencies: { typescript: profile.typescript, '@types/express': profile.typesExpress, '@types/node': '22.20.5' }
  }, null, 2))
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f))
  return dir
}

function main () {
  const filter = process.argv[2] || ''
  const profiles = PROFILES.filter((p) => p.name.includes(filter))
  const tarball = pack()
  process.stdout.write(`packed ${path.basename(tarball)}\n`)
  let failed = 0
  for (const profile of profiles) {
    const dir = setUpProject(profile, tarball)
    const steps = [
      ['install', 'npm', ['install', '--no-audit', '--no-fund', '--no-package-lock']],
      ['runtime (CommonJS)', process.execPath, ['runtime.cjs']],
      ['types: correct usage and misuse', 'npx', ['--no-install', 'tsc', '-p', '.']],
      ['cli from node_modules', 'npx', ['--no-install', 'express-observe', '--version']]
    ]
    process.stdout.write(`\n${profile.name} (express ${profile.express}, @types/express ${profile.typesExpress}, typescript ${profile.typescript})\n`)
    for (const [label, cmd, args] of steps) {
      const r = run(cmd, args, dir)
      process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${label}${r.ok && label.startsWith('cli') ? ` (${r.out.split('\n').pop()})` : ''}\n`)
      if (!r.ok) {
        failed++
        process.stdout.write(r.out.split('\n').slice(-25).map((l) => `        ${l}`).join('\n') + '\n')
        break
      }
    }
  }
  process.stdout.write(`\n${failed === 0 ? 'all consumer profiles passed' : `${failed} profile(s) failed`}\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
