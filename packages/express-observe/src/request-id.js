'use strict'

const { randomUUID } = require('node:crypto')

const MAX_ID_LENGTH = 128
// Restricted charset: safe to echo in a header and to embed in a JSON log line.
// Excludes whitespace, commas (Node joins duplicate headers with ", "), quotes and control characters.
const VALID_ID = /^[A-Za-z0-9._-]+$/

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidRequestId (value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    VALID_ID.test(value)
}

function generateRequestId () {
  return randomUUID()
}

/**
 * Decide which request ID this request carries.
 *
 * Order:
 *   1. An existing valid `req.id` set by an earlier middleware, if policy.onExistingId === 'keep'.
 *   2. A valid incoming header value, if policy.trustIncoming allows it for this request.
 *   3. A freshly generated UUID.
 *
 * Never throws for request-derived input. A throwing `trustIncoming` callback is treated as "do not trust"
 * and reported through `onCallbackError`.
 *
 * @param {import('http').IncomingMessage & { id?: unknown }} req
 * @param {{ headerKey: string, trustIncoming: boolean | ((req: any) => boolean), onExistingId: 'keep' | 'replace' }} policy
 * @param {(err: unknown) => void} onCallbackError
 * @returns {{ id: string, source: 'existing' | 'client' | 'generated' }}
 */
function resolveRequestId (req, policy, onCallbackError) {
  if (policy.onExistingId === 'keep' && isValidRequestId(req.id)) {
    return { id: req.id, source: 'existing' }
  }

  if (shouldTrust(req, policy.trustIncoming, onCallbackError)) {
    const incoming = req.headers[policy.headerKey]
    // Duplicate header lines arrive joined with ", " and therefore fail validation on purpose:
    // there is no safe way to pick one of several client-supplied IDs.
    if (isValidRequestId(incoming)) {
      return { id: incoming, source: 'client' }
    }
  }

  return { id: generateRequestId(), source: 'generated' }
}

function shouldTrust (req, trustIncoming, onCallbackError) {
  if (typeof trustIncoming !== 'function') {
    return trustIncoming === true
  }
  try {
    return trustIncoming(req) === true
  } catch (err) {
    onCallbackError(err)
    return false
  }
}

module.exports = {
  MAX_ID_LENGTH,
  isValidRequestId,
  generateRequestId,
  resolveRequestId
}
