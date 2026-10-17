// Type definitions for express-observe. The package is plain CommonJS JavaScript; these declarations describe its
// public API (ARCHITECTURE.md section 6, README). Requires @types/express 4.17 or 5.x in the consuming project.

import type { Request, RequestHandler, Response } from 'express'

declare function observe (options?: observe.Options): RequestHandler

declare namespace observe {
  /** Same function as the default export, for `const { observe } = require('express-observe')`. */
  const observe: (options?: Options) => RequestHandler

  /**
   * Snapshot of the local diagnostics counters (ADR-0010) for this process or worker thread, across every
   * observe() instance in it. Not a cluster total. Returns a new object on each call; there is no reset, so take
   * differences between snapshots.
   */
  function getDiagnostics (): Diagnostics

  interface Diagnostics {
    schemaVersion: 1
    pid: number
    threadId: number
    /** ISO 8601 time when the package was loaded, i.e. when counting started. */
    since: string
    requests: {
      /** Requests on which an instance began observing (a second instance on the same request is not counted). */
      started: number
      finished: number
      interrupted: number
      /** started - finished - interrupted at the time of the snapshot. */
      inFlight: number
    }
    records: {
      /** Records handed to a sink (the sink was called). Not proof of delivery. */
      emitted: number
      /** Records that could not be built, so the sink was never called. */
      dropped: number
      /** Sink calls that threw or returned a promise that rejected. */
      sinkErrors: number
      /** Promises returned by sinks that have not settled yet. */
      sinkPending: number
    }
    /** Internal warnings, including those whose stderr line was rate-limited. */
    warnings: number
  }

  /** `finished`: the last chunk was handed to the OS. `interrupted`: the connection ended first. */
  type Termination = 'finished' | 'interrupted'

  /** Where `requestId` came from. A `client` ID is correlation data chosen by the client, not identity. */
  type RequestIdSource = 'generated' | 'client' | 'existing'

  /** One access-log record (schemaVersion 1). Fields added by `log.extend` appear as extra keys. */
  interface AccessLogRecord {
    schemaVersion: 1
    /** ISO 8601 UTC wall-clock time when the response terminated. */
    timestamp: string
    requestId: string
    requestIdSource: RequestIdSource
    service: string | null
    release: string | null
    method: string | null
    /** Route template such as `/users/:id`, or null when it cannot be determined safely. Never a raw URL. */
    route: string | null
    /** Status that was actually sent; null if the connection ended before headers were sent. */
    status: number | null
    /** Middleware entry until response headers were written; null if they never were. */
    headerDurationMs: number | null
    /** Middleware entry until the response finished or the connection ended. */
    durationMs: number
    /**
     * Only present with `eventLoop.enabled`. Largest event-loop delay the process saw around this request; null
     * while the sampler has no measurement. Process-level: it does not prove how long this request waited.
     */
    eventLoopDelayMs?: number | null
    termination: Termination
    [extraField: string]: unknown
  }

  interface RequestIdOptions {
    /** Header read from the request (when trusted) and written to the response. Default `X-Request-Id`. */
    header?: string
    /** Accept a valid incoming ID. Default false: the server always generates one. */
    trustIncoming?: boolean | ((req: Request) => boolean)
    /** What to do when an earlier middleware already set a valid `req.id`. Default `keep`. */
    onExistingId?: 'keep' | 'replace'
  }

  interface ServerTimingOptions {
    /** Default true. When false, `res.serverTiming` still exists but does nothing. */
    enabled?: boolean
    /** Custom metrics per response, 1 to 64. Default 16. */
    maxEntries?: number
  }

  interface RouteOptions {
    /** Mount templates for routers, e.g. `['/api', '/users/:userId/posts']`. Literal and `:param` segments only. */
    mounts?: string[] | null
    /** Return a label to use for this request, or anything else to fall back to automatic detection. */
    resolver?: ((req: Request, res: Response) => string | null | undefined) | null
  }

  interface LogOptions {
    /** Default true. */
    enabled?: boolean
    /** Receives each record once, as an object. Default: one JSON line on stdout. */
    sink?: ((record: AccessLogRecord) => void | PromiseLike<unknown>) | null
    /** Called when the sink throws or rejects. Default: a rate-limited stderr line naming the error class. */
    onSinkError?: ((err: unknown, record: AccessLogRecord) => void) | null
    /** Extra fields, opt-in. Core fields always win; you are responsible for what you add. */
    extend?: ((req: Request, res: Response) => Record<string, unknown> | null | undefined) | null
  }

  interface EventLoopOptions {
    /** Adds `eventLoopDelayMs` to every record. Default false. */
    enabled?: boolean
    /** Sampling interval, 5 to 1000 ms. Default 20. A block shorter than this can be missed. */
    resolutionMs?: number
    /**
     * Stop sampling after this many ms with no request in flight and none started; the next request restarts it
     * and reports null. 0 never stops. 100 to 3600000, default 10000.
     */
    idleStopMs?: number
  }

  interface Options {
    service?: string | null
    release?: string | null
    requestId?: RequestIdOptions
    serverTiming?: ServerTimingOptions
    route?: RouteOptions
    log?: LogOptions
    eventLoop?: EventLoopOptions
  }

  /** `res.serverTiming`. No method ever throws; invalid input and calls after headers were sent are ignored. */
  interface ServerTiming {
    /** Start (or restart) a timer. Names: 1-32 chars of A-Z a-z 0-9 _ -; `app` is reserved. */
    start (name: string): void
    /** Stop a running timer. Ignored if it is not running. */
    end (name: string): void
    /** Record a duration measured elsewhere, with an optional description (printable ASCII, max 64 chars). */
    add (name: string, durationMs: number, desc?: string): void
  }
}

declare global {
  // Optional on purpose: a route may run without observe() in front of it (another path, another app), so the
  // types do not promise these properties everywhere. Narrow before use, e.g. `res.serverTiming?.start('db')`.
  namespace Express {
    interface Request {
      /** Set by express-observe on requests it handled. */
      id?: string
    }
    interface Response {
      /** Set by express-observe on responses it handled. */
      serverTiming?: observe.ServerTiming
    }
  }
}

export = observe
