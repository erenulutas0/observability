// Every line marked @ts-expect-error must be a type error. If the types become too loose, the directive is unused
// and tsc fails, so this file guards against regressions in both directions.
import type { Request, Response } from 'express'
import observe = require('express-observe')

// @ts-expect-error unknown top-level option
observe({ sampling: 0.5 })

// @ts-expect-error onExistingId is 'keep' or 'replace'
observe({ requestId: { onExistingId: 'merge' } })

// @ts-expect-error trustIncoming is a boolean or a function
observe({ requestId: { trustIncoming: 'yes' } })

// @ts-expect-error the sink receives the record object, not a string
observe({ log: { sink: (line: string) => line.length } })

// @ts-expect-error extend must return an object (or nothing)
observe({ log: { extend: () => 'tenant-a' } })

// @ts-expect-error mounts is a list of templates
observe({ route: { mounts: '/api' } })

declare const req: Request
declare const res: Response

// @ts-expect-error req.id is not guaranteed: observe() may not run for this route
export const id: string = req.id

// @ts-expect-error res.serverTiming is not guaranteed either; narrow it first
res.serverTiming.start('db')

// @ts-expect-error termination is a closed set
export const termination: observe.Termination = 'aborted'

// durationMs is always a number
export const record: observe.AccessLogRecord = {
  schemaVersion: 1,
  timestamp: '',
  requestId: 'x',
  requestIdSource: 'generated',
  service: null,
  release: null,
  method: 'GET',
  route: null,
  status: null,
  headerDurationMs: null,
  // @ts-expect-error durationMs is always a number
  durationMs: null,
  termination: 'finished'
}

// @ts-expect-error getDiagnostics takes no arguments (there is no per-route or filtered view)
observe.getDiagnostics('/users')

// @ts-expect-error the snapshot has no reset
observe.getDiagnostics().reset()

// @ts-expect-error idleStopMs is a number of milliseconds
observe({ eventLoop: { idleStopMs: '10s' } })
