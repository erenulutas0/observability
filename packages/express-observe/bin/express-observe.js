#!/usr/bin/env node
'use strict'

// express-observe command-line entry point.
//
//   express-observe analyze [options] <file...>    summarize access-log files (use - for stdin)
//   express-observe doctor [options] <url>         check a running server's integration (ADR-0005)
//   express-observe --version | --help
//
// Exit codes: 0 report printed, 1 unreadable input or no valid records, 2 usage error.

const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { createAnalyzer, analyzeStream, parseGroupBy, GROUP_BY, SORT_BY, MAX_SLOWEST, MAX_FIELD_VALUES, MIN_SAMPLES } = require('../src/analyze')
const { renderText } = require('../src/analyze-format')
const doctor = require('../src/doctor')

const VERSION = require('../package.json').version

const MAIN_HELP = `express-observe ${VERSION}

Usage:
  express-observe analyze [options] <file...>
  express-observe doctor [options] <url>
  express-observe --version
  express-observe --help

Commands:
  analyze   Summarize express-observe access-log files per route: counts, 5xx and
            interruption rates, latency percentiles. Run "express-observe analyze --help".
  doctor    Send a few safe GET requests to a running server (loopback only by default)
            and check the integration: request IDs, Server-Timing, and with --log,
            one record per request, route labels and privacy. Run "express-observe doctor --help".
`

const ANALYZE_HELP = `Usage: express-observe analyze [options] <file...>

Reads JSON-lines access logs written by express-observe (or by a logger that wraps
its records) and prints per-group statistics. Use "-" as a file name to read stdin.

Options:
  --by <field>       group by: ${GROUP_BY.join(' | ')} (default method-route),
                     or field:<name> to split each METHOD route by a field added with
                     log.extend (at most ${MAX_FIELD_VALUES} distinct values, the rest are grouped together)
  --only-with-field  with --by field:<name>, leave out records that do not have the field
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

const DOCTOR_HELP = `Usage: express-observe doctor [options] <url>

Checks how express-observe is wired into a server that is already running, using a
few GET requests. <url> is the origin only, e.g. http://127.0.0.1:3000.

Options:
  --path <path>      path to probe, repeatable, up to ${doctor.MAX_PATHS} (default /)
  --log <file>       the server's access-log file; enables record, route and privacy checks
  --header <name>    request ID header name (default X-Request-Id)
  --wait <ms>        wait before reading --log, for buffered sinks (default 500, max 10000)
  --timeout <ms>     hard time limit per request (default 5000, 1000 to 30000)
  --allow-remote     allow a target that is not localhost or a loopback address
  --json             print the report as JSON
  -h, --help         show this help

Safety: every probe is a GET without body, cookies or credentials; redirects are not
followed; at most 2 probes per path plus 2 more, sent one at a time. Each probe is
also sent with a random marker in a query parameter and a header. Only pass paths
that are safe to request repeatedly. The log file is only read, never printed.

Exit codes: 0 no failures (warnings allowed), 1 at least one failure, 2 usage error
or refused target.
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
        'only-with-field': { type: 'boolean' },
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
  try {
    parseGroupBy(groupBy)
  } catch (err) {
    throw new UsageError(err.message)
  }
  const onlyWithField = values['only-with-field'] === true
  if (onlyWithField && !groupBy.startsWith('field:')) throw new UsageError('--only-with-field needs --by field:<name>')
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
      onlyWithField,
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
    const hint = report.input.suspectUtf16 ? '; the input contains NUL characters and may be UTF-16, convert it to UTF-8' : ''
    fail(`no express-observe records found in ${names.join(', ')} (${report.input.linesRead} line(s) read, ${report.input.skippedTotal} skipped${hint})`, 1)
    return
  }
  process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : renderText(report, names))
}

async function runDoctorCommand (argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        path: { type: 'string', multiple: true },
        log: { type: 'string' },
        header: { type: 'string' },
        wait: { type: 'string' },
        timeout: { type: 'string' },
        'allow-remote': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    })
  } catch (err) {
    fail(`${err.message}\nRun "express-observe doctor --help" for usage.`, 2)
    return
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(DOCTOR_HELP)
    return
  }
  if (positionals.length !== 1) {
    fail('doctor needs exactly one target URL, e.g. http://127.0.0.1:3000\nRun "express-observe doctor --help" for usage.', 2)
    return
  }
  if (values.wait !== undefined && !/^\d+$/.test(values.wait)) {
    fail('--wait must be a non-negative integer (milliseconds)', 2)
    return
  }

  let report
  try {
    report = await doctor.runDoctor({
      url: positionals[0],
      paths: values.path,
      log: values.log ?? null,
      header: values.header,
      waitMs: values.wait === undefined ? undefined : Number(values.wait),
      timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout),
      allowRemote: values['allow-remote'] === true,
      version: VERSION
    })
  } catch (err) {
    if (err instanceof doctor.UsageError) {
      fail(`${err.message}\nRun "express-observe doctor --help" for usage.`, 2)
      return
    }
    throw err
  }
  process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : doctor.renderDoctorText(report))
  process.exitCode = report.failures > 0 ? 1 : 0
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
  if (command === 'doctor') return runDoctorCommand(rest)
  fail(`unknown command ${JSON.stringify(command)}\n${MAIN_HELP}`, 2)
}

main(process.argv.slice(2)).catch((err) => {
  fail(`unexpected error: ${err && err.stack}`, 1)
})
