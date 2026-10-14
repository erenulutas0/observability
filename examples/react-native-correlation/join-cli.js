#!/usr/bin/env node
'use strict'

// Usage: node join-cli.js <client-log> <access-log> [--json]
//
// <client-log>  lines containing "client-attempt {...}" (copied from the Metro / Expo console, or written by
//               node-client.js); other lines are ignored
// <access-log>  the server's express-observe JSON lines

const fs = require('node:fs')
const { parseClientLines, parseServerLines, joinAttempts, renderJoin } = require('./join')

function main (argv) {
  const json = argv.includes('--json')
  const files = argv.filter((a) => a !== '--json')
  if (files.length !== 2) {
    process.stderr.write('usage: node join-cli.js <client-log> <access-log> [--json]\n')
    process.exitCode = 2
    return
  }
  let clientText
  let serverText
  try {
    clientText = fs.readFileSync(files[0], 'utf8')
    serverText = fs.readFileSync(files[1], 'utf8')
  } catch (err) {
    process.stderr.write(`cannot read input: ${err.code || err.message}\n`)
    process.exitCode = 1
    return
  }
  const attempts = parseClientLines(clientText.split(/\r?\n/))
  const records = parseServerLines(serverText.split(/\r?\n/))
  if (attempts.length === 0) {
    process.stderr.write(`no client attempts found in ${files[0]}\n`)
    process.exitCode = 1
    return
  }
  const rows = joinAttempts(attempts, records)
  process.stdout.write(json ? JSON.stringify(rows, null, 2) + '\n' : renderJoin(rows))
}

main(process.argv.slice(2))
