// Correct usage must compile under strict settings.
import express = require('express')
import observe = require('express-observe')
import { observe as named, getDiagnostics } from 'express-observe'

const records: observe.AccessLogRecord[] = []

const app = express()
app.use(observe())
app.use(named({ service: 'consumer' }))
app.use(observe({
  service: 'consumer',
  release: null,
  requestId: {
    header: 'X-Correlation-Id',
    trustIncoming: (req) => req.headers['x-internal-proxy'] === '1',
    onExistingId: 'keep'
  },
  serverTiming: { enabled: true, maxEntries: 8 },
  route: {
    mounts: ['/api', '/users/:userId/posts'],
    resolver: (req) => (req.path === '/health' ? '/health' : undefined)
  },
  log: {
    enabled: true,
    sink: (record) => { records.push(record) },
    onSinkError: (err, record) => { console.error(record.requestId, err) },
    extend: (_req, res) => ({ tenant: res.locals.tenant as string | undefined })
  },
  eventLoop: { enabled: true, resolutionMs: 20, idleStopMs: 0 }
}))
app.use(observe({ log: { sink: async (record) => { await Promise.resolve(record) } } }))

app.get('/users/:id', (req, res) => {
  const id: string | undefined = req.id
  res.serverTiming?.start('db')
  res.serverTiming?.end('db')
  res.serverTiming?.add('cache', 0.4, 'hit')
  res.json({ id })
})

export function summarise (record: observe.AccessLogRecord): string {
  const termination: observe.Termination = record.termination
  const source: observe.RequestIdSource = record.requestIdSource
  const status: number | null = record.status
  const header: number | null = record.headerDurationMs
  const loop: number | null | undefined = record.eventLoopDelayMs
  const route: string | null = record.route
  const tenant: unknown = record.tenant
  return `${termination} ${source} ${status ?? '-'} ${header ?? '-'} ${record.durationMs} ${loop ?? '-'} ${route ?? '-'} ${String(tenant)}`
}

export const timing: observe.ServerTiming = { start () {}, end () {}, add () {} }
export const options: observe.Options = { requestId: { trustIncoming: true } }

const diagnostics: observe.Diagnostics = observe.getDiagnostics()
export const open: number = diagnostics.requests.inFlight + getDiagnostics().records.sinkPending
