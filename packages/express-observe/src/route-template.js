'use strict'

// Route labels must never contain concrete request data. Everything here either returns a template written by a
// developer (route pattern, mount template, explicit label) or null.

const MAX_LABEL_LENGTH = 256
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/
const MOUNT_SEGMENT = /^(?::[A-Za-z0-9_]+|[^:*?()[\]\s]+)$/
const MAX_MOUNTS = 256

function isLabel (value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    PRINTABLE_ASCII.test(value)
}

function splitPath (path) {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * Validate and pre-split mount templates such as '/users/:userId/posts'.
 * Supported segments: literals and `:param`. Wildcards, optional or regex params are rejected at startup.
 * @param {unknown} mounts
 */
function compileMounts (mounts) {
  if (mounts === undefined || mounts === null) return []
  if (!Array.isArray(mounts) || mounts.length > MAX_MOUNTS) {
    throw new TypeError(`express-observe: options.route.mounts must be an array of at most ${MAX_MOUNTS} strings`)
  }
  return mounts.map((template) => {
    if (typeof template !== 'string' || !template.startsWith('/') || !isLabel(template)) {
      throw new TypeError(`express-observe: invalid mount template ${JSON.stringify(template)}`)
    }
    const segments = splitPath(template)
    if (segments.length === 0 || !segments.every((s) => MOUNT_SEGMENT.test(s))) {
      throw new TypeError(
        `express-observe: invalid mount template ${JSON.stringify(template)} (use literal and :param segments only)`
      )
    }
    return {
      template: '/' + segments.join('/'),
      segments: segments.map((s) => (s.startsWith(':') ? null : s.toLowerCase()))
    }
  })
}

/** Express 4 routing is case-insensitive by default, so literal segments are compared case-insensitively. */
function matchMount (compiledMounts, baseUrl) {
  const actual = splitPath(baseUrl)
  for (const mount of compiledMounts) {
    if (mount.segments.length !== actual.length) continue
    let ok = true
    for (let i = 0; i < actual.length; i++) {
      const expected = mount.segments[i]
      if (expected !== null && expected !== actual[i].toLowerCase()) {
        ok = false
        break
      }
    }
    if (ok) return mount.template
  }
  return null
}

function joinTemplate (prefix, routePath) {
  if (routePath === '/' || routePath === '') return prefix
  return prefix + routePath
}

/**
 * Remember which route matched and what `req.baseUrl` was *at that moment*.
 *
 * Express 4 assigns `req.route` in Route#dispatch, while `req.baseUrl` is restored when control leaves a router
 * via next()/next(err). Reading both at termination would pair a nested leaf pattern with the wrong prefix on
 * error paths. A per-request accessor on `req.route` captures the pair at assignment time. It does not patch any
 * Express prototype; reads of `req.route` keep returning the same value.
 *
 * @returns {() => ({ path: unknown, baseUrl: string } | null)}
 */
function trackMatchedRoute (req) {
  const snapshot = (route) => (route ? { path: route.path, baseUrl: currentBaseUrl(req) } : null)
  let value = req.route
  let captured = snapshot(value)

  try {
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get () {
        return value
      },
      set (next) {
        value = next
        captured = snapshot(next)
      }
    })
  } catch {
    // Non-configurable property installed by someone else: fall back to reading at termination.
    return () => snapshot(req.route)
  }

  return () => captured
}

function currentBaseUrl (req) {
  return typeof req.baseUrl === 'string' ? req.baseUrl : ''
}

function templateFromMatch (matched, compiledMounts) {
  if (matched === null || !isLabel(matched.path) || !matched.path.startsWith('/')) return null
  if (matched.baseUrl === '' || matched.baseUrl === '/') return matched.path
  const prefix = matchMount(compiledMounts, matched.baseUrl)
  if (prefix === null) return null
  const label = joinTemplate(prefix, matched.path)
  return isLabel(label) ? label : null
}

/**
 * Resolution order (ARCHITECTURE.md section 4.3):
 *   1. res.locals.observeRoute (string)
 *   2. options.route.resolver(req, res) returning a string
 *   3. matched leaf route pattern, with mount prefix resolved through options.route.mounts
 *   4. null
 */
function resolveRouteLabel (req, res, matched, routeConfig, warn) {
  const local = res.locals ? res.locals.observeRoute : undefined
  if (isLabel(local)) return local

  if (routeConfig.resolver !== null) {
    try {
      const resolved = routeConfig.resolver(req, res)
      if (isLabel(resolved)) return resolved
    } catch (err) {
      warn('route.resolver threw; falling back to automatic route detection', err)
    }
  }

  return templateFromMatch(matched, routeConfig.mounts)
}

module.exports = {
  compileMounts,
  trackMatchedRoute,
  resolveRouteLabel
}
