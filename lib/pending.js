/**
 * The pending-decision registry: one state machine per open HITL request,
 * owning its countdown, its interaction hold, and the exactly-once settlement
 * that releases the blocked tool call.
 *
 * The clock is injected so tests drive seconds without waiting for them, and so
 * every timer this plugin arms passes through one place that can be cleared on
 * unload.
 */

import { ERROR_CODES, OUTCOMES } from './protocol.js'

/** Default cap on how long one browser may freeze a countdown by interacting. */
export const DEFAULT_HOLD_GRACE_MS = 300000

/** Decision a countdown action applies when it reaches zero. */
export function timeoutDecision(action) {
  if (action === 'approve') return { kind: 'approve' }
  return { kind: 'reject' }
}

/**
 * Create one process-wide pending registry.
 * @param options - injected clock/timers, settlement sink, and hold grace.
 * @returns the registry API used by the host half.
 */
export function createPendingRegistry({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onSettle = () => {},
  holdGraceMs = DEFAULT_HOLD_GRACE_MS,
} = {}) {
  const entries = new Map()
  const settledOrder = []
  // Settled identities outlive their entry so a late or duplicated decision is
  // reported as already-settled rather than as an unknown request. The set is
  // only a diagnostic, so it is dropped wholesale rather than aged.
  const settledIds = new Set()
  const SETTLED_MEMORY = 4096

  /** Verdict for an identity that has no open entry. */
  function missing(id) {
    return settledIds.has(id) ? ERROR_CODES.alreadySettled : ERROR_CODES.unknownRequest
  }

  function clearEntryTimers(entry) {
    if (entry.timer !== undefined) {
      clearTimer(entry.timer)
      entry.timer = undefined
    }
    if (entry.graceTimer !== undefined) {
      clearTimer(entry.graceTimer)
      entry.graceTimer = undefined
    }
  }

  function armCountdown(entry) {
    if (entry.countdownMs === null || entry.settled) return
    const delay = Math.max(0, entry.remainingMs)
    entry.timer = setTimer(() => {
      entry.timer = undefined
      close(entry.id, OUTCOMES.timeout, timeoutDecision(entry.countdownAction))
    }, delay)
  }

  function releaseHold(entry) {
    if (!entry.held) return
    entry.held = false
    entry.holdExpiresAt = undefined
    if (entry.graceTimer !== undefined) {
      clearTimer(entry.graceTimer)
      entry.graceTimer = undefined
    }
    // Re-base the countdown so the frozen remainder is what still runs, and so a
    // later hold computes the remainder from the resumed clock rather than from
    // the original deadline that already passed.
    entry.startedAt = now() + entry.remainingMs - entry.countdownMs
    armCountdown(entry)
  }

  function close(id, source, decision) {
    const entry = entries.get(id)
    if (entry === undefined) return { accepted: false, code: missing(id) }
    if (entry.settled) return { accepted: false, code: ERROR_CODES.alreadySettled }
    clearEntryTimers(entry)
    entry.settled = true
    entry.settledAt = now()
    entry.source = source
    entry.decision = decision
    entries.delete(id)
    settledOrder.push(id)
    settledIds.add(id)
    if (settledIds.size > SETTLED_MEMORY) settledIds.clear()
    onSettle(entry, { decision, source })
    return { accepted: true }
  }

  return {
    /**
     * Register one open decision.
     * @param input - identity, wire request, countdown policy, and callbacks.
     * @returns `{ ok: true }` or `{ ok: false, code }` for a duplicate id.
     */
    open({ id, request, countdown, onTimeout }) {
      if (entries.has(id)) return { ok: false, code: ERROR_CODES.alreadySettled }
      const countdownMs = countdown === null || countdown === undefined ? null : countdown.remainingMs
      const entry = {
        id,
        request,
        countdownMs,
        countdownAction: countdown?.action ?? 'reject',
        freezeOnInteract: countdown?.freezeOnInteract !== false,
        onTimeout,
        remainingMs: countdownMs ?? 0,
        startedAt: now(),
        held: false,
        holdExpiresAt: undefined,
        timer: undefined,
        graceTimer: undefined,
        settled: false,
        settledAt: undefined,
        source: undefined,
        decision: undefined,
      }
      entries.set(id, entry)
      armCountdown(entry)
      return { ok: true, expiresAt: countdownMs === null ? undefined : entry.startedAt + countdownMs }
    },

    /** Apply the human's decision. First call wins; later calls are reported. */
    settle(id, decision) {
      return close(id, OUTCOMES.user, decision)
    },

    /**
     * Freeze or resume one countdown while its browser holds the decision.
     * @param id - request identity.
     * @param held - whether the browser is still interacting.
     * @returns the acceptance, and when a hold stops applying on its own.
     */
    hold(id, held) {
      const entry = entries.get(id)
      if (entry === undefined) return { ok: false, code: missing(id) }
      if (entry.settled) return { ok: false, code: ERROR_CODES.alreadySettled }
      if (entry.countdownMs === null) return { ok: true, held: false }
      if (!entry.freezeOnInteract) return { ok: true, held: false }
      if (held) {
        if (entry.held) return { ok: true, held: true, expiresAt: entry.holdExpiresAt }
        entry.remainingMs = Math.max(0, entry.startedAt + entry.countdownMs - now())
        entry.held = true
        if (entry.timer !== undefined) {
          clearTimer(entry.timer)
          entry.timer = undefined
        }
        entry.holdExpiresAt = now() + holdGraceMs
        entry.graceTimer = setTimer(() => {
          entry.graceTimer = undefined
          releaseHold(entry)
        }, holdGraceMs)
        return { ok: true, held: true, expiresAt: entry.holdExpiresAt }
      }
      releaseHold(entry)
      return { ok: true, held: false }
    },

    /** Withdraw one request (turn interruption, unload, or host-side cancel). */
    abort(id, source = OUTCOMES.abort) {
      return close(id, source, { kind: 'cancel' })
    },

    /** Withdraw every open request; used on plugin teardown. */
    drain(source = OUTCOMES.host) {
      const ids = [...entries.keys()]
      for (const id of ids) close(id, source, { kind: 'cancel' })
      return ids
    },

    /** Whether one request identity is still open. */
    has(id) {
      return entries.has(id)
    },

    /** The wire request behind one identity, or undefined once settled. */
    get(id) {
      return entries.get(id)?.request
    },

    /** Every open request, in registration order. */
    list() {
      return [...entries.values()].map(entry => entry.request)
    },

    /** Count of open requests. */
    size() {
      return entries.size
    },

    /** Identities settled so far, in settlement order (diagnostics and tests). */
    settled() {
      return [...settledOrder]
    },

    /** Whether one request's countdown is currently frozen by a client. */
    held(id) {
      return entries.get(id)?.held === true
    },

    /** Remaining milliseconds of one countdown, or null when it has none. */
    remaining(id) {
      const entry = entries.get(id)
      if (entry === undefined || entry.countdownMs === null) return null
      if (entry.held) return entry.remainingMs
      return Math.max(0, entry.startedAt + entry.countdownMs - now())
    },
  }
}
