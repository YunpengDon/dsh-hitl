/**
 * dsh-hitl host half: the human-in-the-loop gate for tool calls.
 *
 * Other tools and plugins mount HITL through the `hitl` service this plugin
 * provides (`ctx.hitl.protect(...)`), or a user mounts them from this row's
 * `config.protect` list. A mounted call is intercepted on `tools/pre-execute`,
 * the proposal is broadcast to every connected browser, and the human's answer
 * becomes the pre-execution decision: allow, deny with the user's own words, or
 * deny with the revised proposal.
 *
 * The browser half is `client.js`; the two halves meet on this plugin's own
 * same-origin HTTP route (a Server-Sent-Events downlink plus one JSON uplink),
 * because a profile-installed bundle can neither add a generated Remote
 * namespace nor extend the shipped forwarded-event allowlist. The route is
 * closed by a per-process token injected into the served index.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'

import {
  DEFAULT_ENDPOINT, ERROR_CODES, GLOBAL_KEY, LIMITS, OUTCOMES, errorBody, frameHoldAck,
  framePing, frameRequest, frameSettled, frameSnapshot, okBody, parseUplink, sseChunk,
} from './lib/protocol.js'
import { buildRequest, capReason, describeDecision, isRevision, revisionContext } from './lib/fields.js'
import { DEFAULT_HOLD_GRACE_MS, createPendingRegistry } from './lib/pending.js'
import { matchMount, mountApplies, normalizeMount, normalizeProtectList } from './lib/resolve.js'

/** Plugin name, as the row and diagnostics label it. */
export const name = 'hitl'

/** Error identities the model reads alongside a denied call. */
const FAILURES = {
  rejected: { name: 'HitlRejected', code: 'HITL_REJECTED' },
  revised: { name: 'HitlRevised', code: 'HITL_REVISED' },
  timeout: { name: 'HitlTimeout', code: 'HITL_TIMEOUT' },
  unavailable: { name: 'HitlUnavailable', code: 'HITL_UNAVAILABLE' },
}

/** Heartbeat period of one SSE downlink. */
const HEARTBEAT_MS = 15000

/** Loopback forms a decision request may arrive from. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value === '') return DEFAULT_ENDPOINT
  const trimmed = value.startsWith('/') ? value : `/${value}`
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Process-wide symbol holding the tokens this process has handed to pages. */
const TOKEN_REGISTRY = Symbol.for('dsh-hitl.decision-tokens')

/** How many previously issued tokens stay acceptable, oldest dropped first. */
const TOKEN_MEMORY = 8

/**
 * The decision token for this process.
 *
 * The token is injected into every served page, so rotating it on a plugin
 * reload would strand every open page until it is refreshed: each page keeps
 * presenting the token it booted with, and its event stream would never open
 * again. The first activation in a process therefore mints the token, every
 * later activation reuses it, and every token this process issued stays
 * acceptable until the registry's bound drops it.
 * @returns the token to inject and accept.
 */
function processTokens() {
  const existing = globalThis[TOKEN_REGISTRY]
  if (existing instanceof Set) return existing
  const registry = new Set()
  Object.defineProperty(globalThis, TOKEN_REGISTRY, { value: registry, enumerable: false })
  return registry
}

/**
 * Register the HITL host half.
 * @param ctx - host Cordis context of this plugin row.
 * @param config - `{ protect, endpoint, holdGraceMs }` from the row.
 */
export function apply(ctx, config = {}) {
  const options = config === null || typeof config !== 'object' ? {} : config
  const warn = message => {
    const line = `dsh-hitl: ${message}`
    try {
      if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn(line)
      else console.warn(line)
    } catch {
      console.warn(line)
    }
  }

  const tokens = processTokens()
  const token = tokens.size === 0 ? randomUUID() : [...tokens][0]
  tokens.add(token)
  while (tokens.size > TOKEN_MEMORY) {
    const oldest = [...tokens][0]
    if (oldest === token) break
    tokens.delete(oldest)
  }
  const endpoint = normalizeEndpoint(options.endpoint)
  const mounts = []
  const clients = new Set()
  const resolvers = new Map()
  const cleanups = new Map()
  const revisions = new Map()

  const registry = createPendingRegistry({
    holdGraceMs: positiveInteger(options.holdGraceMs, DEFAULT_HOLD_GRACE_MS),
    onSettle: (entry, settlement) => {
      const cleanup = cleanups.get(entry.id)
      if (cleanup !== undefined) {
        cleanups.delete(entry.id)
        try {
          cleanup()
        } catch (error) {
          warn(`abort listener cleanup failed: ${String(error)}`)
        }
      }
      broadcast(frameSettled(entry.id, settlement.source))
      const resolve = resolvers.get(entry.id)
      resolvers.delete(entry.id)
      if (resolve !== undefined) resolve(settlement)
    },
  })

  /**
   * Re-read one request's countdown as it stands right now.
   *
   * The request object is built once, when the call is gated, so its
   * `remainingMs` is the countdown's full length. A browser that receives that
   * object later — on a reconnect snapshot, or after a client-module reload —
   * would restart the visible countdown from the full length while the host
   * clock kept running, and the panel would then claim time the call no longer
   * has. Every frame therefore carries the host's own remainder.
   */
  function liveRequest(request) {
    if (request.countdown === null || request.countdown === undefined) return request
    const remainingMs = registry.remaining(request.id)
    if (remainingMs === null) return request
    return { ...request, countdown: { ...request.countdown, remainingMs, held: registry.held(request.id) } }
  }

  /** Push one frame to every connected browser, dropping the ones that fail. */
  function broadcast(frame) {
    const payload = sseChunk(frame)
    for (const client of clients) {
      try {
        client.res.write(payload)
      } catch (error) {
        warn(`dropping a decision client: ${String(error)}`)
        dropClient(client)
      }
    }
  }

  function dropClient(client) {
    if (!clients.delete(client)) return
    try {
      clearInterval(client.heartbeat)
    } catch {
      /* the heartbeat is best-effort cleanup */
    }
  }

  // ── mounting ───────────────────────────────────────────────────────────────

  /**
   * Mount HITL on one tool matcher.
   *
   * Pass the calling plugin's context as `owner` to tie the mount to that
   * plugin's fiber: unloading the plugin then removes the mount even if the
   * returned disposer is never called. Without an owner the mount lives until
   * the disposer runs or this plugin unloads, so keep it in your own effect.
   *
   * @param matcher - tool name, `*` glob, RegExp, array of those, or a predicate over the call.
   * @param mountOptions - title, fields, layout, labels, buttons, countdown, reject, modify, whenUnavailable.
   * @param owner - the calling plugin's Cordis context, for lifetime binding.
   * @returns a disposer removing this exact mount.
   */
  function protect(matcher, mountOptions = {}, owner) {
    const normalized = normalizeMount({ matcher, ...mountOptions }, 'hitl.protect()')
    for (const message of normalized.warnings) warn(message)
    if (!normalized.ok) throw new TypeError(`dsh-hitl: unusable tool matcher ${String(matcher)}`)
    mounts.push(normalized.mount)
    const release = () => {
      const index = mounts.indexOf(normalized.mount)
      if (index !== -1) mounts.splice(index, 1)
    }
    // A mount must not outlive the plugin that asked for it, and returning a
    // disposer from `apply` is not a lifetime: only an effect on the caller's
    // own context is disposed when that plugin unloads.
    if (owner !== undefined && owner !== null && typeof owner.effect === 'function') {
      try {
        owner.effect(() => release, `dsh-hitl: mount ${normalized.mount.describe}`)
      } catch (error) {
        warn(`the mount for ${normalized.mount.describe} could not be tied to its owner: ${String(error)}`)
      }
    }
    return release
  }

  /** Remove every mount whose matcher reads like the given one; returns how many. */
  function unprotect(matcher) {
    const target = normalizeMount({ matcher }, 'hitl.unprotect()')
    if (!target.ok) return 0
    const before = mounts.length
    for (let index = mounts.length - 1; index >= 0; index -= 1) {
      if (mounts[index].describe === target.mount.describe) mounts.splice(index, 1)
    }
    return before - mounts.length
  }

  const service = {
    protect,
    unprotect,
    /** Every mount currently registered, newest last. */
    list: () => mounts.map(mount => ({
      matcher: mount.describe,
      layout: mount.options.layout,
      title: mount.options.title,
      countdown: mount.options.countdown,
      rejectFeedback: mount.options.reject.feedback,
      modify: mount.options.modify.mode,
      whenUnavailable: mount.options.whenUnavailable,
    })),
    /** Every decision still waiting for a human, oldest first. */
    pending: () => registry.list().map(request => ({
      id: request.id,
      sessionId: request.sessionId,
      toolName: request.toolName,
      createdAt: request.createdAt,
    })),
  }

  const rowMounts = normalizeProtectList(options.protect, 'config.protect')
  for (const message of rowMounts.warnings) warn(message)
  mounts.push(...rowMounts.mounts)

  // ── the gate ───────────────────────────────────────────────────────────────

  function unavailable(exec, reason) {
    return {
      kind: 'deny',
      reason: capReason(`HITL: ${reason}, so tool ${JSON.stringify(exec.name)} did not run (fail-closed).`),
      info: FAILURES.unavailable,
    }
  }

  /** Wait for one human decision, or for the host to withdraw the request. */
  function waitForDecision(id, request, mount, exec) {
    return new Promise(resolve => {
      const countdown = mount.options.countdown === null ? null : {
        remainingMs: mount.options.countdown.seconds * 1000,
        action: mount.options.countdown.action,
        freezeOnInteract: mount.options.countdown.freezeOnInteract,
      }
      resolvers.set(id, resolve)
      const opened = registry.open({ id, request, countdown })
      if (!opened.ok) {
        resolvers.delete(id)
        resolve({ decision: { kind: 'cancel' }, source: OUTCOMES.host })
        return
      }
      const signal = exec.signal
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted) {
          registry.abort(id)
        } else {
          const onAbort = () => { registry.abort(id) }
          signal.addEventListener('abort', onAbort, { once: true })
          cleanups.set(id, () => { signal.removeEventListener('abort', onAbort) })
        }
      }
      broadcast(frameRequest(liveRequest(request)))
    })
  }

  /**
   * Map one settled decision onto the pre-execution decision vocabulary.
   * @param exec - the pending call, for its name and call id.
   * @param request - the wire request the human decided on.
   * @param mount - the mount that gated the call.
   * @param settlement - `{ decision, source }` from the registry.
   * @returns the decision the tool registry applies.
   */
  function toPreToolDecision(exec, request, mount, settlement) {
    if (settlement.decision.kind === 'approve') return { kind: 'allow' }
    if (settlement.decision.kind === 'cancel') return { kind: 'cancel' }
    const revising = isRevision(settlement.decision)
    if (revising && mount.options.modify.mode === 'allow-and-inform' && settlement.source === OUTCOMES.user) {
      if (exec.callId !== undefined) revisions.set(String(exec.callId), { request, decision: settlement.decision })
      return { kind: 'allow' }
    }
    const info = settlement.source === OUTCOMES.timeout
      ? FAILURES.timeout
      : (revising ? FAILURES.revised : FAILURES.rejected)
    return {
      kind: 'deny',
      reason: capReason(describeDecision(request, settlement.decision, settlement.source)),
      info,
    }
  }

  async function gate(exec, next) {
    let mount
    try {
      mount = matchMount(mounts, exec)
    } catch (error) {
      warn(`a mount matcher failed: ${String(error)}`)
      return next()
    }
    if (mount === undefined || !mountApplies(mount, exec)) return next()
    const sessionId = exec.agent === undefined || exec.agent === null ? undefined : exec.agent.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      warn(`tool ${JSON.stringify(exec.name)} is mounted on HITL but its call carries no agent to route a decision through`)
      return unavailable(exec, 'the call has no agent to route a decision through')
    }
    if (clients.size === 0 && mount.options.whenUnavailable === 'reject') {
      warn(`tool ${JSON.stringify(exec.name)} needs a human decision but no browser is connected`)
      return unavailable(exec, 'no browser is connected to decide')
    }
    const id = `hitl:${String(exec.callId ?? randomUUID())}`
    try {
      const request = buildRequest({ execution: exec, mount, sessionId, id })
      const settlement = await waitForDecision(id, request, mount, exec)
      return toPreToolDecision(exec, request, mount, settlement)
    } catch (error) {
      warn(`tool ${JSON.stringify(exec.name)} could not be put to a human: ${String(error)}`)
      registry.abort(id)
      return unavailable(exec, 'the HITL panel failed to open')
    }
  }

  ctx.on('tools/pre-execute', (exec, next) => gate(exec, next), { prepend: true })

  // ── approved-with-edits context ────────────────────────────────────────────

  /**
   * Hand the user's revision to the model next to the result it approved, in
   * the `allow-and-inform` modify mode. The message is built to the shape
   * `createUserMessage` produces, because a plain bundle cannot import that
   * factory; `source.kind` is the standard `user` one.
   */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (revisions.size === 0 || exec.callId === undefined) return decision
    const key = String(exec.callId)
    const revision = revisions.get(key)
    if (revision === undefined) return decision
    revisions.delete(key)
    try {
      const message = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: capReason(revisionContext(revision.request, revision.decision)) }],
      }
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] }
    } catch (error) {
      warn(`the revision context for ${key} was dropped: ${String(error)}`)
      return decision
    }
  })

  // ── transport ──────────────────────────────────────────────────────────────

  function authorized(req, queryToken) {
    const header = req.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
    const presented = typeof queryToken === 'string' && queryToken !== '' ? queryToken : bearer
    if (typeof presented !== 'string' || presented === '') return false
    const candidate = Buffer.from(presented)
    let accepted = false
    for (const known of tokens) {
      const expected = Buffer.from(known)
      // Every candidate is compared, so timing does not reveal which token matched.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) accepted = true
    }
    return accepted
  }

  function loopback(req) {
    const address = req.socket?.remoteAddress
    return typeof address === 'string' && LOOPBACK.has(address)
  }

  function sameOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function refuse(res, status, code, message) {
    sendJson(res, status, errorBody(code, message))
  }

  function openEvents(req, res, url) {
    if (!loopback(req) || !authorized(req, url.searchParams.get('token'))) {
      refuse(res, 401, ERROR_CODES.unauthorized, 'a valid decision token is required')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const client = { res, heartbeat: undefined }
    // A real frame, not an SSE comment: only a frame proves to the browser half
    // that this stream is still the live one, so its watchdog can tell a silent
    // orphaned stream from a healthy one.
    client.heartbeat = setInterval(() => {
      try {
        res.write(sseChunk(framePing()))
      } catch {
        dropClient(client)
      }
    }, HEARTBEAT_MS)
    if (typeof client.heartbeat?.unref === 'function') client.heartbeat.unref()
    clients.add(client)
    try {
      res.write(sseChunk(frameSnapshot(registry.list().map(liveRequest))))
    } catch (error) {
      warn(`the pending snapshot could not be written: ${String(error)}`)
      dropClient(client)
      return
    }
    req.on('close', () => { dropClient(client) })
    req.on('error', () => { dropClient(client) })
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > LIMITS.maxBodyBytes) {
          reject(new Error('payload too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      req.on('error', reject)
    })
  }

  async function decide(req, res, url) {
    if (!loopback(req) || !authorized(req, url.searchParams.get('token')) || !sameOrigin(req)) {
      refuse(res, 401, ERROR_CODES.unauthorized, 'a valid decision token is required')
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
      refuse(res, 400, ERROR_CODES.badPayload, 'content-type must be application/json')
      return
    }
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      refuse(res, 413, ERROR_CODES.badPayload, error instanceof Error ? error.message : String(error))
      return
    }
    let payload
    try {
      payload = JSON.parse(raw === '' ? 'null' : raw)
    } catch {
      refuse(res, 400, ERROR_CODES.badPayload, 'the body must be JSON')
      return
    }
    const parsed = parseUplink(payload)
    if (!parsed.ok) {
      refuse(res, 400, parsed.code, parsed.message)
      return
    }
    const uplink = parsed.value
    if (uplink.type === 'hold') {
      const held = registry.hold(uplink.id, uplink.held)
      if (!held.ok) {
        refuse(res, held.code === ERROR_CODES.unknownRequest ? 404 : 409, held.code, 'that decision is no longer open')
        return
      }
      broadcast(frameHoldAck(uplink.id, held.held, held.expiresAt, registry.remaining(uplink.id)))
      sendJson(res, 200, {
        ...okBody(true),
        held: held.held,
        ...(held.expiresAt === undefined ? {} : { expiresAt: held.expiresAt }),
      })
      return
    }
    const settled = registry.settle(uplink.id, uplink.decision)
    if (!settled.accepted) {
      refuse(res, settled.code === ERROR_CODES.unknownRequest ? 404 : 409, settled.code, 'that decision is no longer open')
      return
    }
    sendJson(res, 200, okBody(true))
  }

  function handler(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      refuse(res, 400, ERROR_CODES.badPayload, 'unreadable request target')
      return
    }
    if (url.pathname === `${endpoint}/events`) {
      if (req.method !== 'GET') {
        refuse(res, 405, ERROR_CODES.badPayload, 'the event stream is a GET route')
        return
      }
      openEvents(req, res, url)
      return
    }
    if (url.pathname === `${endpoint}/status`) {
      // Read-only troubleshooting surface: no token, no payload, loopback only.
      // It exists so a developer can answer "is a browser attached, what is
      // gated right now, and how many tokens did this process issue" without
      // reading logs or guessing.
      if (req.method !== 'GET' || !loopback(req)) {
        refuse(res, 401, ERROR_CODES.unauthorized, 'the status route is a loopback GET')
        return
      }
      sendJson(res, 200, {
        ok: true,
        clients: clients.size,
        tokens: tokens.size,
        protecting: service.list(),
        pending: service.pending().map(request => ({
          ...request,
          remainingMs: registry.remaining(request.id),
          held: registry.held(request.id),
        })),
      })
      return
    }
    if (url.pathname === `${endpoint}/decide`) {
      if (req.method !== 'POST') {
        refuse(res, 405, ERROR_CODES.badPayload, 'decisions arrive on POST')
        return
      }
      void decide(req, res, url).catch((error) => {
        warn(`the decision route failed: ${String(error)}`)
        try {
          refuse(res, 500, ERROR_CODES.hostGone, 'the host could not accept that decision')
        } catch {
          /* the response is already gone */
        }
      })
      return
    }
    refuse(res, 404, ERROR_CODES.badPayload, 'unknown HITL route')
  }

  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: endpoint, handler }),
      'dsh-hitl: decision transport',
    )
  })

  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: GLOBAL_KEY, value: { token, endpoint } })
  })

  // ── lifetime ───────────────────────────────────────────────────────────────

  ctx.effect(() => {
    const disposers = [ctx.provide('hitl', service)]
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          warn(`service disposal failed: ${String(error)}`)
        }
      }
    }
  }, 'dsh-hitl: hitl service')

  ctx.effect(() => () => {
    registry.drain(OUTCOMES.host)
    // End, do not merely forget: a reload leaves each open socket owned by a
    // dead closure, and a browser cannot see that. Closing it makes the browser
    // reconnect to the next instance instead of waiting on a silent stream.
    for (const client of [...clients]) {
      dropClient(client)
      try {
        client.res.end()
      } catch {
        /* the socket is already gone */
      }
    }
    for (const cleanup of cleanups.values()) {
      try {
        cleanup()
      } catch {
        /* listeners are already being removed with the fiber */
      }
    }
    mounts.length = 0
    revisions.clear()
    resolvers.clear()
    cleanups.clear()
  }, 'dsh-hitl: shutdown')
}
