import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ERROR_CODES, OUTCOMES } from '../lib/protocol.js'
import { createPendingRegistry, timeoutDecision } from '../lib/pending.js'

/** Deterministic clock/timers so seconds pass in one call. */
function fakeClock() {
  let current = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimer: (callback, delay) => {
      const id = nextId
      nextId += 1
      timers.set(id, { at: current + Math.max(0, delay), callback })
      return id
    },
    clearTimer: id => { timers.delete(id) },
    pendingTimers: () => timers.size,
    advance(ms) {
      const target = current + ms
      for (let guard = 0; guard < 1000; guard += 1) {
        let next
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === undefined || timer.at < next.timer.at)) next = { id, timer }
        }
        if (next === undefined) break
        timers.delete(next.id)
        current = next.timer.at
        next.timer.callback()
      }
      current = target
    },
  }
}

/** One registry wired to a fake clock and the settlements it produced. */
function registryOf(options = {}) {
  const clock = fakeClock()
  const settlements = []
  const registry = createPendingRegistry({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onSettle: (entry, settlement) => { settlements.push({ id: entry.id, request: entry.request, ...settlement }) },
    ...options,
  })
  return { clock, settlements, registry }
}

const REQUEST = { id: 'r1', sessionId: 's1', toolName: 'bash', countdown: null }

describe('pending: settlement', () => {
  it('accepts the first decision and reports later ones', () => {
    const { registry, settlements } = registryOf()
    assert.deepEqual(registry.open({ id: 'r1', request: REQUEST, countdown: null, onTimeout: undefined }), { ok: true, expiresAt: undefined })
    assert.equal(registry.has('r1'), true)
    assert.deepEqual(registry.list(), [REQUEST])
    assert.equal(registry.size(), 1)
    assert.deepEqual(registry.settle('r1', { kind: 'approve' }), { accepted: true })
    assert.equal(registry.has('r1'), false)
    assert.equal(registry.size(), 0)
    assert.deepEqual(settlements, [{ id: 'r1', request: REQUEST, decision: { kind: 'approve' }, source: OUTCOMES.user }])
    assert.deepEqual(registry.settle('r1', { kind: 'reject' }), { accepted: false, code: ERROR_CODES.alreadySettled })
    assert.deepEqual(registry.settle('nope', { kind: 'reject' }), { accepted: false, code: ERROR_CODES.unknownRequest })
    assert.deepEqual(registry.settled(), ['r1'])
  })

  it('refuses a duplicate identity', () => {
    const { registry } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: null })
    assert.deepEqual(registry.open({ id: 'r1', request: REQUEST, countdown: null }), { ok: false, code: ERROR_CODES.alreadySettled })
  })

  it('exposes the open request until it settles', () => {
    const { registry } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: null })
    assert.equal(registry.get('r1'), REQUEST)
    registry.settle('r1', { kind: 'approve' })
    assert.equal(registry.get('r1'), undefined)
  })
})

describe('pending: countdown', () => {
  it('maps the three actions', () => {
    assert.deepEqual(timeoutDecision('approve'), { kind: 'approve' })
    assert.deepEqual(timeoutDecision('reject'), { kind: 'reject' })
    assert.deepEqual(timeoutDecision('notify'), { kind: 'reject' })
  })

  it('settles at the deadline with the configured action', () => {
    const { registry, clock, settlements } = registryOf()
    const opened = registry.open({
      id: 'r1', request: REQUEST, countdown: { remainingMs: 30000, action: 'notify', freezeOnInteract: true },
    })
    assert.deepEqual(opened, { ok: true, expiresAt: 30000 })
    clock.advance(29999)
    assert.equal(registry.size(), 1)
    clock.advance(1)
    assert.deepEqual(settlements, [{ id: 'r1', request: REQUEST, decision: { kind: 'reject' }, source: OUTCOMES.timeout }])
    assert.equal(clock.pendingTimers(), 0)
  })

  it('approves on timeout when configured to', () => {
    const { registry, clock, settlements } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 1000, action: 'approve', freezeOnInteract: true } })
    clock.advance(1000)
    assert.equal(settlements[0].decision.kind, 'approve')
    assert.equal(settlements[0].source, OUTCOMES.timeout)
  })

  it('reports the remaining time and stops counting once settled', () => {
    const { registry, clock } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 10000, action: 'reject', freezeOnInteract: true } })
    clock.advance(4000)
    assert.equal(registry.remaining('r1'), 6000)
    registry.settle('r1', { kind: 'approve' })
    assert.equal(registry.remaining('r1'), null)
  })

  it('has no countdown when the mount configured none', () => {
    const { registry, clock, settlements } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: null })
    clock.advance(10 ** 7)
    assert.equal(settlements.length, 0)
    assert.equal(registry.remaining('r1'), null)
    assert.equal(clock.pendingTimers(), 0)
  })
})

describe('pending: interaction hold', () => {
  it('freezes the countdown and resumes with the frozen remainder', () => {
    const { registry, clock, settlements } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 10000, action: 'reject', freezeOnInteract: true } })
    clock.advance(4000)
    assert.deepEqual(registry.hold('r1', true), { ok: true, held: true, expiresAt: 4000 + 300000 })
    clock.advance(60000)
    assert.equal(settlements.length, 0)
    assert.equal(registry.remaining('r1'), 6000)
    assert.deepEqual(registry.hold('r1', false), { ok: true, held: false })
    clock.advance(5999)
    assert.equal(settlements.length, 0)
    clock.advance(1)
    assert.equal(settlements.length, 1)
  })

  it('is idempotent while held', () => {
    const { registry } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 10000, action: 'reject', freezeOnInteract: true } })
    const first = registry.hold('r1', true)
    assert.deepEqual(registry.hold('r1', true), first)
  })

  it('releases the hold on its own after the grace window', () => {
    const { registry, clock, settlements } = registryOf({ holdGraceMs: 1000 })
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 5000, action: 'reject', freezeOnInteract: true } })
    clock.advance(1000)
    assert.deepEqual(registry.hold('r1', true), { ok: true, held: true, expiresAt: 2000 })
    clock.advance(1000)
    clock.advance(5000)
    assert.equal(settlements.length, 1)
  })

  it('ignores a hold the mount did not opt into, or a request without a countdown', () => {
    const { registry, settlements, clock } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 1000, action: 'reject', freezeOnInteract: false } })
    assert.deepEqual(registry.hold('r1', true), { ok: true, held: false })
    registry.open({ id: 'r2', request: REQUEST, countdown: null })
    assert.deepEqual(registry.hold('r2', true), { ok: true, held: false })
    clock.advance(1000)
    assert.equal(settlements.length, 1)
    assert.equal(settlements[0].id, 'r1')
  })

  it('reports unknown and settled identities', () => {
    const { registry } = registryOf()
    assert.deepEqual(registry.hold('nope', true), { ok: false, code: ERROR_CODES.unknownRequest })
    registry.open({ id: 'r1', request: REQUEST, countdown: null })
    registry.settle('r1', { kind: 'approve' })
    assert.deepEqual(registry.hold('r1', true), { ok: false, code: ERROR_CODES.alreadySettled })
  })

  it('drops a hold timer when the request settles', () => {
    const { registry, clock, settlements } = registryOf({ holdGraceMs: 60000 })
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 60000, action: 'reject', freezeOnInteract: true } })
    registry.hold('r1', true)
    assert.equal(clock.pendingTimers(), 1)
    registry.settle('r1', { kind: 'approve' })
    assert.equal(clock.pendingTimers(), 0)
    clock.advance(120000)
    assert.equal(settlements.length, 1)
  })
})

describe('pending: withdrawal', () => {
  it('cancels through abort and drain', () => {
    const { registry, settlements, clock } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 1000, action: 'reject', freezeOnInteract: true } })
    registry.open({ id: 'r2', request: REQUEST, countdown: null })
    assert.deepEqual(registry.abort('r2'), { accepted: true })
    assert.deepEqual(registry.drain(), ['r1'])
    assert.equal(registry.size(), 0)
    assert.deepEqual(settlements.map(entry => [entry.id, entry.decision, entry.source]), [
      ['r2', { kind: 'cancel' }, OUTCOMES.abort],
      ['r1', { kind: 'cancel' }, OUTCOMES.host],
    ])
    clock.advance(10000)
    assert.equal(settlements.length, 2)
  })

  it('drains nothing when no request is open', () => {
    const { registry } = registryOf()
    assert.deepEqual(registry.drain(), [])
  })
})

describe('pending: projected countdown state', () => {
  it('reports the frozen remainder and the hold while a client holds it', () => {
    const { registry, clock } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: { remainingMs: 30000, action: 'reject', freezeOnInteract: true } })
    clock.advance(10000)
    assert.equal(registry.remaining('r1'), 20000)
    assert.equal(registry.held('r1'), false)
    registry.hold('r1', true)
    assert.equal(registry.held('r1'), true)
    assert.equal(registry.remaining('r1'), 20000, 'a held countdown reads its frozen remainder')
    registry.hold('r1', false)
    assert.equal(registry.held('r1'), false)
    assert.equal(registry.remaining('r1'), 20000)
  })

  it('reports no countdown and no hold for a request without one', () => {
    const { registry } = registryOf()
    registry.open({ id: 'r1', request: REQUEST, countdown: null })
    assert.equal(registry.remaining('r1'), null)
    assert.equal(registry.held('r1'), false)
  })
})
