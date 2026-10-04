import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ERROR_CODES, LIMITS, PROTOCOL_VERSION, errorBody, frameHoldAck, frameRequest, frameSettled,
  frameSnapshot, isDecision, isRecord, okBody, parseUplink, sseChunk, truncate,
} from '../lib/protocol.js'

describe('protocol: guards', () => {
  it('accepts plain records only', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord([]), false)
    assert.equal(isRecord(null), false)
    assert.equal(isRecord('x'), false)
  })

  it('accepts the three decision kinds', () => {
    assert.equal(isDecision({ kind: 'approve' }), true)
    assert.equal(isDecision({ kind: 'reject' }), true)
    assert.equal(isDecision({ kind: 'reject', feedback: 'no' }), true)
    assert.equal(isDecision({ kind: 'modify', fields: [{ param: 'a', text: 'b' }] }), true)
    assert.equal(isDecision({ kind: 'modify', fields: [] }), true)
    assert.equal(isDecision({ kind: 'cancel' }), false)
    assert.equal(isDecision({ kind: 'modify', fields: [{ param: 'a' }] }), false)
    assert.equal(isDecision({ kind: 'reject', feedback: 7 }), false)
  })
})

describe('protocol: parseUplink', () => {
  it('rejects non-objects and missing ids', () => {
    assert.equal(parseUplink(null).code, ERROR_CODES.badPayload)
    assert.equal(parseUplink({ type: 'decide', decision: { kind: 'approve' } }).code, ERROR_CODES.badPayload)
    assert.equal(parseUplink({ id: '', type: 'decide', decision: { kind: 'approve' } }).code, ERROR_CODES.badPayload)
  })

  it('rejects unknown types and decisions', () => {
    assert.equal(parseUplink({ id: 'a', type: 'nope' }).code, ERROR_CODES.badPayload)
    assert.equal(parseUplink({ id: 'a', type: 'decide', decision: { kind: 'maybe' } }).code, ERROR_CODES.badPayload)
  })

  it('normalizes an approve decision', () => {
    const parsed = parseUplink({ id: 'a', type: 'decide', decision: { kind: 'approve' } })
    assert.deepEqual(parsed.value, { type: 'decide', id: 'a', decision: { kind: 'approve' } })
  })

  it('drops empty reject feedback', () => {
    assert.deepEqual(parseUplink({ id: 'a', type: 'decide', decision: { kind: 'reject', feedback: '   ' } }).value.decision, { kind: 'reject' })
    assert.deepEqual(parseUplink({ id: 'a', type: 'decide', decision: { kind: 'reject', feedback: ' 慢 ' } }).value.decision, { kind: 'reject', feedback: '慢' })
  })

  it('requires at least one changed field for a modify decision', () => {
    assert.equal(parseUplink({ id: 'a', type: 'decide', decision: { kind: 'modify', fields: [] } }).code, ERROR_CODES.badPayload)
    const parsed = parseUplink({
      id: 'a', type: 'decide', decision: { kind: 'modify', fields: [{ param: 'cmd', text: 'ls' }, { param: '', text: 'x' }] },
    })
    assert.deepEqual(parsed.value.decision.fields, [{ param: 'cmd', text: 'ls' }])
  })

  it('normalizes a hold frame', () => {
    assert.deepEqual(parseUplink({ id: 'a', type: 'hold', held: true }).value, { type: 'hold', id: 'a', held: true })
    assert.equal(parseUplink({ id: 'a', type: 'hold', held: 'yes' }).code, ERROR_CODES.badPayload)
  })
})

describe('protocol: frames', () => {
  it('stamps the version and keeps optional fields out when absent', () => {
    assert.deepEqual(frameSnapshot([]), { type: 'snapshot', version: PROTOCOL_VERSION, requests: [] })
    assert.deepEqual(frameRequest({ id: 'a' }), { type: 'request', version: PROTOCOL_VERSION, request: { id: 'a' } })
    assert.deepEqual(frameSettled('a', 'user'), { type: 'settled', version: PROTOCOL_VERSION, id: 'a', outcome: 'user' })
    assert.deepEqual(frameSettled('a', 'user', 'client-1'), { type: 'settled', version: PROTOCOL_VERSION, id: 'a', outcome: 'user', decidedBy: 'client-1' })
    assert.deepEqual(frameHoldAck('a', true, 12), { type: 'holdAck', version: PROTOCOL_VERSION, id: 'a', held: true, expiresAt: 12 })
    assert.deepEqual(frameHoldAck('a', false), { type: 'holdAck', version: PROTOCOL_VERSION, id: 'a', held: false })
  })

  it('serializes one SSE data chunk', () => {
    assert.equal(sseChunk({ type: 'ping' }), 'data: {"type":"ping"}\n\n')
  })

  it('wraps route bodies', () => {
    assert.deepEqual(errorBody('bad-payload', 'nope'), { ok: false, code: 'bad-payload', message: 'nope' })
    assert.deepEqual(okBody(true), { ok: true, accepted: true })
  })
})

describe('protocol: truncate', () => {
  it('passes short text through', () => {
    assert.deepEqual(truncate('abc', 5), { text: 'abc', truncated: false })
  })

  it('marks long text', () => {
    const cut = truncate('abcdefghij', 4)
    assert.equal(cut.truncated, true)
    assert.equal(cut.text.startsWith('abcd'), true)
    assert.equal(cut.text.includes('已截断，共 10 字'), true)
  })

  it('exposes sane default limits', () => {
    assert.equal(LIMITS.maxFieldChars > 0, true)
    assert.equal(LIMITS.maxBodyBytes > LIMITS.maxFieldChars, true)
  })
})

describe('protocol: hold acknowledgement', () => {
  it('carries the host remainder when it has one', () => {
    assert.deepEqual(frameHoldAck('a', true, 1200, 45000), {
      type: 'holdAck', version: PROTOCOL_VERSION, id: 'a', held: true, expiresAt: 1200, remainingMs: 45000,
    })
    assert.deepEqual(frameHoldAck('a', false, undefined, 30000), {
      type: 'holdAck', version: PROTOCOL_VERSION, id: 'a', held: false, remainingMs: 30000,
    })
  })

  it('omits a remainder it does not have', () => {
    assert.deepEqual(frameHoldAck('a', false), { type: 'holdAck', version: PROTOCOL_VERSION, id: 'a', held: false })
    assert.deepEqual(frameHoldAck('a', false, undefined, null), { type: 'holdAck', version: PROTOCOL_VERSION, id: 'a', held: false })
  })
})
