'use strict'

// What really happens when an async handler rejects, observed in a separate Node process (Jest installs its own
// unhandled-rejection handling, which would hide Node's default behaviour). express-observe installs no global
// handlers, so these outcomes are Express's and Node's, not the middleware's.

const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')

const EXPRESS_MAJOR = Number(require('express/package.json').version.split('.')[0])
// Under jest.express5.config.js, 'express' is mapped to the express5 alias; the child must load the same one.
const EXPRESS_MODULE = require.resolve(EXPRESS_MAJOR >= 5 ? 'express5' : 'express')
const FIXTURE = path.join(__dirname, 'fixtures', 'async-rejection-app.js')

function startChild (nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, FIXTURE], {
    env: { ...process.env, EXPRESS_MODULE, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const state = { stdout: '', stderr: '', records: [], exit: null }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    state.exit = { code, signal }
    resolve(state.exit)
  }))
  const port = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      state.stdout += chunk
      for (const line of state.stdout.split('\n')) {
        if (line.startsWith('PORT ')) resolve(Number(line.slice(5)))
      }
      state.records = state.stdout.split('\n').filter((l) => l.startsWith('RECORD ')).map((l) => JSON.parse(l.slice(7)))
    })
    child.stderr.on('data', (chunk) => { state.stderr += chunk })
    child.once('exit', () => reject(new Error(`child exited before listening: ${state.stderr}`)))
  })
  return { child, state, exited, port }
}

/** GET with a client-side abort after `abortMs`; resolves with the status or the error code. */
function get (port, urlPath, abortMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.setTimeout(abortMs, () => req.destroy(Object.assign(new Error('client gave up'), { code: 'CLIENT_ABORT' })))
    req.on('error', (err) => resolve({ error: err.code }))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('rejected async handlers, in a real Node process', () => {
  ;(EXPRESS_MAJOR === 4 ? test : test.skip)('Express 4, Node defaults: the rejection is unhandled and the process exits', async () => {
    const { state, exited, port } = startChild()
    const p = await port
    const response = await get(p, '/async-fail', 2000)
    const exit = await exited
    expect(exit.code).not.toBe(0)
    expect(state.stderr).toContain('fixture async failure')
    expect(response.error).toBeDefined() // the connection died with the process
    expect(state.records).toHaveLength(0) // no record: the process was gone before the response ended
  }, 15000)

  ;(EXPRESS_MAJOR === 4 ? test : test.skip)('Express 4, --unhandled-rejections=warn: the process lives, the request stays open until the client gives up', async () => {
    const { child, state, port } = startChild(['--unhandled-rejections=warn'])
    try {
      const p = await port
      const response = await get(p, '/async-fail', 300)
      expect(response.error).toBe('CLIENT_ABORT')
      await sleep(200)
      expect(state.records).toHaveLength(1)
      expect(state.records[0]).toMatchObject({ route: '/async-fail', status: null, termination: 'interrupted' })
      expect(await get(p, '/ok', 2000)).toEqual({ status: 200 }) // the process still serves requests
    } finally {
      child.kill()
    }
  }, 15000)

  ;(EXPRESS_MAJOR >= 5 ? test : test.skip)('Express 5, Node defaults: the rejection becomes a 500 and the process keeps serving', async () => {
    const { child, state, port } = startChild()
    try {
      const p = await port
      expect(await get(p, '/async-fail', 2000)).toEqual({ status: 500 })
      await sleep(100)
      expect(state.records[0]).toMatchObject({ route: '/async-fail', status: 500, termination: 'finished' })
      expect(await get(p, '/ok', 2000)).toEqual({ status: 200 })
      expect(state.exit).toBeNull()
    } finally {
      child.kill()
    }
  }, 15000)
})
