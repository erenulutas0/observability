#!/usr/bin/env node
'use strict'

// express-observe command-line entry point.
//
//   express-observe analyze [options] <file...>    summarize access-log files (use - for stdin)
//   express-observe --version | --help
//
// Exit codes: 0 report printed, 1 unreadable input or no valid records, 2 usage error.

const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { createAnalyzer, analyzeStream, GROUP_BY, SORT_BY, MAX_SLOWEST, MIN_SAMPLES } = require('../src/analyze')
const { renderText } = require('../src/analyze-format')

const VERSION = require('../package.json').version

const MAIN_HELP = `express-observe ${VERSION}

Usage:
  express-observe analyze [options] <file...>
  express-observe --version
  express-observe --help

Commands:
  analyze   Summarize express-observe access-log files per route: counts, 5xx and
            interruption rates, latency percentiles. Run "express-observe analyze --help".
`

const ANALYZE_HELP = `Usage: express-observe analyze [options] <file...>

Reads JSON-lines access logs written by express-observe (or by a logger that wraps
its records) and prints per-group statistics. Use "-" as a file name to read stdin.

Options:
  --by <field>       group by: ${GROUP_BY.join(' | ')} (default method-route)
  --sort <field>     sort groups by: ${SORT_BY.join(' | ')} (default count)
  --top <n>          show the first n groups, 0 for all (default 20)
  --since <time>     ignore records before this ISO 8601 time
  --until <time>     ignore records after this ISO 8601 time
  --slowest <n>      also list the n slowest finished requests with their request IDs
                     (max ${MAX_SLOWEST}, default 0)
  --json             print the report as JSON instead of a table
  -h, --help         show this help

Latency percentiles use finished requests only. p95 needs at least ${MIN_SAMPLES.p95} and p99 at
least ${MIN_SAMPLES.p99} values in a group; with fewer they are reported as "-" (null in JSON).

Exit codes: 0 report printed, 1 unreadable input or no valid records, 2 usage error.
`

class UsageError extends Error {}

function fail (message, code) {
  process.stderr.write(`express-observe: ${message}\n`)
  process.exitCode = code
}

function parseTime (value, name) {
  if (value === undefined) return null
  const t = Date.parse(value)
  if (!Number.isFinite(t)) throw new UsageError(`--${name} must be an ISO 8601 time, got ${JSON.stringify(value)}`)
  return t
}

function parseCount (value, name, fallback, max) {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a non-negative integer`)
  const n = Number(value)
  if (max !== undefined && n > max) throw new UsageError(`--${name} must be at most ${max}`)
  return n
}

function parseAnalyzeArgs (argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        by: { type: 'string' },
        sort: { type: 'string' },
        top: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        slowest: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    })
  } catch (err) {
    throw new UsageError(err.message)
  }
  const { values, positionals } = parsed
  if (values.help) return { help: true }

  const groupBy = values.by ?? 'method-route'
  if (!GROUP_BY.includes(groupBy)) throw new UsageError(`--by must be one of ${GROUP_BY.join(', ')}`)
  const sortBy = values.sort ?? 'count'
  if (!SORT_BY.includes(sortBy)) throw new UsageError(`--sort must be one of ${SORT_BY.join(', ')}`)
  if (positionals.length === 0) throw new UsageError('no input files (use - to read stdin)')
  if (positionals.filter((p) => p === '-').length > 1) throw new UsageError('stdin (-) can be given only once')

  const since = parseTime(values.since, 'since')
  const until = parseTime(values.until, 'until')
  if (since !== null && until !== null && since > until) throw new UsageError('--since is later than --until')

  return {
    files: positionals,
    json: values.json === true,
    analyzer: {
      groupBy,
      sortBy,
      top: parseCount(values.top, 'top', 20),
      since,
      until,
      slowest: parseCount(values.slowest, 'slowest', 0, MAX_SLOWEST)
    }
  }
}

function openInput (file) {
  if (file === '-') return { name: 'stdin', stream: process.stdin }
  const stream = fs.createReadStream(file)
  return { name: path.basename(file), stream }
}

async function runAnalyze (argv) {
  let options
  try {
    options = parseAnalyzeArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) {
      fail(`${err.message}\nRun "express-observe analyze --help" for usage.`, 2)
      return
    }
    throw err
  }
  if (options.help) {
    process.stdout.write(ANALYZE_HELP)
    return
  }

  const analyzer = createAnalyzer(options.analyzer)
  const names = []
  for (const file of options.files) {
    const { name, stream } = openInput(file)
    names.push(name)
    try {
      await analyzeStream(stream, analyzer)
    } catch (err) {
      const reason = err && err.code === 'ENOENT' ? 'no such file' : err && err.code === 'EISDIR' ? 'is a directory' : (err && err.code) || 'read error'
      fail(`cannot read ${JSON.stringify(file)}: ${reason}`, 1)
      return
    }
  }

  const report = analyzer.report()
  if (report.input.records === 0) {
    fail(`no express-observe records found in ${names.join(', ')} (${report.input.linesRead} line(s) read, ${report.input.skippedTotal} skipped)`, 1)
    return
  }
  process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : renderText(report, names))
}

async function main (argv) {
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(MAIN_HELP)
    if (command === undefined) process.exitCode = 2
    return
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (command === 'analyze') return runAnalyze(rest)
  fail(`unknown command ${JSON.stringify(command)}\n${MAIN_HELP}`, 2)
}

main(process.argv.slice(2)).catch((err) => {
  fail(`unexpected error: ${err && err.stack}`, 1)
})
