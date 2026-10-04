/**
 * The dsh-hitl wire protocol: the normative definition of every frame the host
 * half broadcasts, every payload the browser half sends back, and the limits
 * both sides agree on.
 *
 * Both halves are plain JavaScript loaded without a build step, so `client.js`
 * cannot import this module. It re-implements the few shapes it must produce;
 * the tests in `tests/protocol.test.js` pin the contract the two halves share.
 * Anything the wire carries is untrusted on arrival and passes a validator here
 * before it reaches the gate.
 */

/** Bumped when a frame shape changes incompatibly. */
export const PROTOCOL_VERSION = 1

/** The `globalThis` property the served index carries this plugin's boot facts in. */
export const GLOBAL_KEY = '__DSH_HITL__'

/** Default route prefix the host half owns on the browser HTTP carrier. */
export const DEFAULT_ENDPOINT = '/dsh-hitl'

/** Discriminator of the pending-interaction values the browser half publishes. */
export const PENDING_KIND = 'hitl'

/** Bounds applied to untrusted input and to what reaches the browser. */
export const LIMITS = {
  /** Largest uplink body the decide route accepts. */
  maxBodyBytes: 256 * 1024,
  /** Longest rendered value of one field before truncation. */
  maxFieldChars: 20000,
  /** Longest decision text folded into one model-facing message. */
  maxDecisionChars: 8000,
}

/** Failure vocabulary shared by the HTTP replies and the panel's error state. */
export const ERROR_CODES = {
  unauthorized: 'unauthorized',
  badPayload: 'bad-payload',
  unknownRequest: 'unknown-request',
  alreadySettled: 'already-settled',
  hostGone: 'host-gone',
}

/** How a pending request left the pending set. */
export const OUTCOMES = {
  user: 'user',
  timeout: 'timeout',
  abort: 'abort',
  host: 'host',
}

/** Structural guard for plain records (not arrays, not null). */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural guard for the decision vocabulary the uplink may carry. */
export function isDecision(value) {
  if (!isRecord(value)) return false
  if (value.kind === 'approve') return true
  if (value.kind === 'reject') {
    return value.feedback === undefined || typeof value.feedback === 'string'
  }
  if (value.kind === 'modify') {
    return Array.isArray(value.fields)
      && value.fields.every(entry => isRecord(entry)
        && typeof entry.param === 'string'
        && typeof entry.text === 'string')
  }
  return false
}

/**
 * Normalize one untrusted uplink payload.
 * @param value - parsed JSON body of a decide/hold request.
 * @returns `{ ok: true, value }` with a trimmed decision, or `{ ok: false, code, message }`.
 */
export function parseUplink(value) {
  if (!isRecord(value)) return invalid('the uplink body must be a JSON object')
  if (typeof value.id !== 'string' || value.id === '') return invalid('id must be a non-empty string')
  if (value.type === 'hold') {
    if (typeof value.held !== 'boolean') return invalid('hold.held must be a boolean')
    return { ok: true, value: { type: 'hold', id: value.id, held: value.held } }
  }
  if (value.type !== 'decide') return invalid(`unknown uplink type ${JSON.stringify(value.type)}`)
  if (!isDecision(value.decision)) return invalid('decision must be approve, modify, or reject')
  const decision = value.decision
  if (decision.kind === 'reject') {
    const feedback = typeof decision.feedback === 'string' ? decision.feedback.trim() : ''
    return {
      ok: true,
      value: {
        type: 'decide',
        id: value.id,
        decision: feedback === '' ? { kind: 'reject' } : { kind: 'reject', feedback },
      },
    }
  }
  if (decision.kind === 'modify') {
    const fields = decision.fields
      .map(entry => ({ param: entry.param, text: entry.text }))
      .filter(entry => entry.param !== '')
    if (fields.length === 0) return invalid('a modify decision must carry at least one field change')
    return { ok: true, value: { type: 'decide', id: value.id, decision: { kind: 'modify', fields } } }
  }
  return { ok: true, value: { type: 'decide', id: value.id, decision: { kind: 'approve' } } }
}

function invalid(message) {
  return { ok: false, code: ERROR_CODES.badPayload, message }
}

/** Frame announcing the complete pending set; sent on connect and on demand. */
export function frameSnapshot(requests) {
  return { type: 'snapshot', version: PROTOCOL_VERSION, requests }
}

/** Frame announcing one newly pending request. */
export function frameRequest(request) {
  return { type: 'request', version: PROTOCOL_VERSION, request }
}

/** Frame announcing one request left the pending set. */
export function frameSettled(id, outcome, decidedBy) {
  return {
    type: 'settled',
    version: PROTOCOL_VERSION,
    id,
    outcome,
    ...(decidedBy === undefined ? {} : { decidedBy }),
  }
}

/** Liveness frame: it carries nothing, and proves the stream is still attached. */
export function framePing() {
  return { type: 'ping', version: PROTOCOL_VERSION }
}

/**
 * Frame answering a hold request: whether the host froze the countdown, when a
 * hold stops applying on its own, and the remainder the host now holds.
 *
 * The remainder travels with the ack because a freeze and a release both move
 * the deadline; a client that kept counting on its own clock would show a
 * number the host disagrees with on the very frame the pause ends.
 */
export function frameHoldAck(id, held, expiresAt, remainingMs) {
  return {
    type: 'holdAck',
    version: PROTOCOL_VERSION,
    id,
    held,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(remainingMs === null || remainingMs === undefined ? {} : { remainingMs }),
  }
}

/** One Server-Sent-Event data chunk carrying a JSON frame. */
export function sseChunk(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/** JSON body of a failed route call. */
export function errorBody(code, message) {
  return { ok: false, code, message }
}

/** JSON body of a successful route call. */
export function okBody(accepted) {
  return { ok: true, accepted }
}

/**
 * Cap one string at a limit, marking that it was cut.
 * @param text - value to bound.
 * @param limit - maximum character count.
 * @returns the value, cut with a trailing notice when it exceeded the limit.
 */
export function truncate(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}\n… [已截断，共 ${text.length} 字]`, truncated: true }
}
