/**
 * Proposal construction: turning one pending tool execution plus its mount into
 * the wire request the browser renders, and turning a human decision back into
 * the text the model reads.
 *
 * Defaults follow the plugin's core promise: with no configuration at all, the
 * proposal is the call's own parameters — one field per parameter, titled by the
 * parameter's key, rendered as an editable markdown box.
 *
 * A mount that must show something the arguments do not carry — the file a call
 * is about to overwrite, the node it is about to delete — declares it as a
 * function; `resolveFields` runs those before the request is built. The browser
 * half stays a pure renderer of the wire shape and needs no change for them.
 */

import { LIMITS, truncate } from './protocol.js'
import { defaultEditable } from './resolve.js'

/** Model-facing prefix every reason this plugin produces starts with. */
export const REASON_PREFIX = 'HITL'

/** Default bound on one computed field, used when the mount sets no `resolveTimeoutMs`. */
export const RESOLVE_TIMEOUT_MS = LIMITS.resolveTimeoutMs

/** Render a parameter value as proposal text. */
export function renderValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return '(undefined)'
  try {
    const json = JSON.stringify(value, null, 2)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/**
 * The default renderer of one parameter value: an editable markdown box, for
 * every value. A non-string value reaches it as pretty-printed JSON text, and a
 * mount that prefers the read-only JSON inspector says `render: 'json'`.
 * @returns the render mode, always `'markdown'`.
 */
export function inferRender() {
  return 'markdown'
}

/** Whether a value is computed from the pending call instead of read from an argument. */
export function isResolver(value) {
  return typeof value === 'function'
}

/**
 * The diff option that applies to one field: the field's own, else the mount's.
 *
 * Shared by the renderer and the resolver on purpose: a field must never be
 * resolved as a diff and then rendered as something else, or the other way
 * round.
 */
function diffOptionOf(spec, mount) {
  const requested = spec.diff ?? mount.options.diff
  return typeof requested === 'object' && requested !== null && !Array.isArray(requested)
    ? requested
    : undefined
}

function schemaOf(execution) {
  const parameters = execution.schema?.parameters
  return typeof parameters === 'object' && parameters !== null ? parameters : undefined
}

function schemaEntry(execution, param) {
  const schema = schemaOf(execution)
  const entry = schema === undefined ? undefined : schema[param]
  return typeof entry === 'object' && entry !== null ? entry : undefined
}

function argumentsOf(execution) {
  const args = execution.arguments
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? args : undefined
}

/**
 * Derive the default field list of one call: every parameter, in argument order.
 * @param execution - the pending tool execution.
 * @returns field specs (`{ param, title? }`) before values are attached.
 */
export function defaultFieldSpecs(execution) {
  const args = argumentsOf(execution)
  if (args === undefined) return [{ param: '(arguments)', render: 'json' }]
  const keys = Object.keys(args)
  if (keys.length === 0) return [{ param: '(arguments)', render: 'json' }]
  return keys.map(param => ({ param }))
}

function diffSpec(spec, mount, execution) {
  const requested = diffOptionOf(spec, mount)
  if (requested === undefined) return undefined
  const before = requested.before
  const after = requested.after
  // Function sides are computed before the request is built (see
  // `resolveFields`); this path only pairs two arguments.
  if (typeof before !== 'string' || typeof after !== 'string') return undefined
  const args = argumentsOf(execution)
  if (args === undefined) return undefined
  return {
    path: typeof requested.path === 'string' ? renderValue(args[requested.path]) : undefined,
    oldText: renderValue(args[before]),
    newText: renderValue(args[after]),
  }
}

// ── computed fields ─────────────────────────────────────────────────────────

/**
 * Await one resolver with a bound.
 *
 * A resolver is caller-supplied code, so it can hang; the gate must not hang
 * with it. The losing side of the race keeps running — a promise cannot be
 * cancelled — but nothing awaits it, and the timer is unref'd so a pending
 * timeout never holds the process open on its own.
 */
async function callResolver(resolver, execution, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => resolver(execution)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out after ${timeoutMs}ms`)) }, timeoutMs)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Render whatever a resolver returned as field text. */
function renderComputed(value) {
  return value === undefined || value === null ? '' : renderValue(value)
}

/**
 * Read one diff side: a resolver computes it, a string names the argument that
 * carries it. `path` may also be a literal, because the file a call is about to
 * change is often not one of the call's parameters.
 */
async function readDiffSide(declared, key, execution, timeoutMs) {
  if (isResolver(declared)) {
    return renderComputed(await callResolver(declared, execution, timeoutMs, `diff.${key}`))
  }
  const args = argumentsOf(execution)
  const carried = args === undefined ? undefined : args[declared]
  if (carried === undefined && key === 'path') return declared
  return renderValue(carried)
}

/**
 * Resolve the computed parts of one field spec.
 * @param spec - the field spec.
 * @param mount - the matched mount, for a mount-level diff.
 * @param execution - the pending call.
 * @param settings - `{ timeoutMs, warn }`.
 * @returns `{ kind: 'text' | 'diff' | 'error', ... }`, or undefined when the spec computes nothing.
 */
async function resolveSpec(spec, mount, execution, settings) {
  const requested = diffOptionOf(spec, mount)
  const value = isResolver(spec.value) ? spec.value : undefined
  const sides = requested === undefined
    ? []
    : ['path', 'before', 'after'].filter(key => isResolver(requested[key]))
  if (value === undefined && sides.length === 0) return undefined
  try {
    if (sides.length === 0) {
      const computed = await callResolver(value, execution, settings.timeoutMs, 'fields[].value')
      return { kind: 'text', text: renderComputed(computed) }
    }
    const [path, oldText, newText] = await Promise.all([
      readDiffSide(requested.path, 'path', execution, settings.timeoutMs),
      readDiffSide(requested.before, 'before', execution, settings.timeoutMs),
      readDiffSide(requested.after, 'after', execution, settings.timeoutMs),
    ])
    return { kind: 'diff', diff: { path, oldText, newText } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    settings.warn(`a computed field could not be resolved (${message}); the panel shows the failure instead`)
    // Degrade to a visible field, never to a blocked gate: the human can still
    // decide on the call itself, and every other field still renders.
    return { kind: 'error', message: `⚠️ 无法解析该字段：${message}` }
  }
}

/**
 * Resolve every computed field of one mount against the pending call.
 *
 * Only specs that declare a resolver are resolved, so a mount made of plain
 * argument fields pays nothing and keeps its proposal unchanged.
 *
 * @param execution - the pending call.
 * @param mount - the matched mount.
 * @param options - `{ timeoutMs, warn }`; defaults to `RESOLVE_TIMEOUT_MS` and silence.
 * @returns `{ fields: Map<spec, result>, mountDiff? }`, to hand to `buildRequest`.
 */
export async function resolveFields(execution, mount, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : RESOLVE_TIMEOUT_MS
  const settings = {
    timeoutMs,
    warn: typeof options.warn === 'function' ? options.warn : () => {},
  }
  const fields = new Map()
  if (mount.options.fields !== undefined) {
    for (const spec of mount.options.fields) {
      const resolved = await resolveSpec(spec, mount, execution, settings)
      if (resolved !== undefined) fields.set(spec, resolved)
    }
  }
  // Without an explicit field list, `buildFields` derives one field per
  // parameter and appends the mount's diff as a field of its own; that diff
  // computes on its own too.
  const mountDiff = mount.options.fields === undefined
    ? await resolveSpec({ param: 'diff' }, mount, execution, settings)
    : undefined
  return { fields, mountDiff }
}

/** Whether a mount asks the host to compute any part of its proposal. */
export function hasComputed(options) {
  const computed = requested => requested !== undefined && requested !== null
    && ['path', 'before', 'after'].some(key => isResolver(requested[key]))
  if (computed(options.diff)) return true
  return (options.fields ?? []).some(spec => isResolver(spec.value) || computed(spec.diff))
}

/** Bound one side of a diff by lines, marking what was cut. */
function boundDiffSide(text) {
  const lines = text.split('\n')
  if (lines.length <= LIMITS.maxDiffLines) return text
  return [
    ...lines.slice(0, LIMITS.maxDiffLines),
    `… [已截断，另有 ${lines.length - LIMITS.maxDiffLines} 行未显示]`,
  ].join('\n')
}

/** Bound both sides of one diff, so a whole-file diff cannot become an unbounded frame. */
function boundDiff(diff) {
  return { ...diff, oldText: boundDiffSide(diff.oldText), newText: boundDiffSide(diff.newText) }
}

/** Label of the field a mount-level `diff` produces when its sides are computed. */
function diffPairLabel(requested) {
  const side = entry => (typeof entry === 'string' ? entry : 'computed')
  return `${side(requested.before)}→${side(requested.after)}`
}

/**
 * Build the wire fields of one request.
 * @param execution - the pending tool execution.
 * @param mount - the matched mount.
 * @param resolution - optional `resolveFields` result for this call.
 * @returns an ordered field array, values already rendered and truncated.
 */
export function buildFields(execution, mount, resolution) {
  const options = mount.options
  const args = argumentsOf(execution)
  const mountDiff = diffOptionOf({}, mount)
  // A mount-level diff pairs two parameters, so those parameters must not also
  // appear as their own fields in the defaulted list.
  const paired = options.fields === undefined && mountDiff !== undefined
    ? new Set([mountDiff.before, mountDiff.after].filter(entry => typeof entry === 'string'))
    : new Set()
  const specs = options.fields
    ?? defaultFieldSpecs(execution).filter(spec => !paired.has(spec.param))
  const fields = []
  for (const spec of specs) {
    const param = spec.param
    const schema = schemaEntry(execution, param)
    // The scalar fallback field reads the whole argument value; every other
    // field reads its own parameter out of the argument record.
    const raw = param === '(arguments)' && args === undefined
      ? execution.arguments
      : (args === undefined ? undefined : args[param])
    const computed = resolution === undefined || resolution.fields === undefined
      ? undefined
      : resolution.fields.get(spec)
    const computedDiff = computed !== undefined && computed.kind === 'diff' ? computed.diff : undefined
    const render = computed !== undefined && computed.kind === 'error'
      ? 'text'
      : computedDiff !== undefined
        ? 'diff'
        : spec.render ?? (diffSpec(spec, mount, execution) === undefined ? inferRender(raw) : 'diff')
    const diff = computedDiff ?? (render === 'diff' ? diffSpec(spec, mount, execution) : undefined)
    const title = spec.title
      ?? (typeof schema?.title === 'string' ? schema.title : undefined)
      ?? param
    const description = spec.description
      ?? (typeof schema?.description === 'string' ? schema.description : undefined)
    const editable = spec.editable ?? defaultEditable(render)
    // A literal `value` replaces the parameter text; a function `value` was
    // already turned into `computed` before this ran.
    const declared = typeof spec.value === 'string' ? spec.value : undefined
    // A hidden field carries no value: it exists only to stay out of the panel.
    const value = computed !== undefined && computed.kind === 'error'
      ? { text: computed.message, truncated: false }
      : (computed !== undefined && computed.kind === 'text' && diff === undefined && render !== 'hidden'
        ? truncate(computed.text, options.maxFieldChars)
        : (diff === undefined && render !== 'hidden'
          ? truncate(declared ?? renderValue(raw), options.maxFieldChars)
          : { text: '', truncated: false }))
    fields.push({
      param,
      title,
      ...(description === undefined ? {} : { description }),
      render,
      editable: render === 'diff' || render === 'hidden' ? false : editable,
      labels: spec.labels ?? [],
      ...(diff === undefined ? { value: value.text, truncated: value.truncated } : { diff: boundDiff(diff) }),
    })
  }
  if (options.fields === undefined && mountDiff !== undefined) {
    const computed = resolution === undefined ? undefined : resolution.mountDiff
    const title = typeof options.diff.title === 'string' ? options.diff.title : 'diff'
    if (computed !== undefined && computed.kind === 'error') {
      fields.push({
        param: 'diff',
        title,
        render: 'text',
        editable: false,
        labels: [],
        value: computed.message,
        truncated: false,
      })
    } else {
      const diff = computed !== undefined && computed.kind === 'diff'
        ? computed.diff
        : diffSpec({ diff: mountDiff }, mount, execution)
      if (diff !== undefined) {
        fields.push({
          param: diffPairLabel(options.diff),
          title,
          render: 'diff',
          editable: false,
          labels: [],
          diff: boundDiff(diff),
        })
      }
    }
  }
  if (fields.length === 0) {
    return [{ param: '(arguments)', title: '(arguments)', render: 'json', editable: false, labels: [], value: '{}', truncated: false }]
  }
  return fields
}

/**
 * Build one complete wire request.
 * @param input - `{ execution, mount, sessionId, id, now, resolution }`.
 * @returns the request object broadcast to browsers.
 */
export function buildRequest({ execution, mount, sessionId, id, now = Date.now(), resolution }) {
  const options = mount.options
  const fields = buildFields(execution, mount, resolution)
  const countdown = options.countdown === null ? null : {
    remainingMs: options.countdown.seconds * 1000,
    action: options.countdown.action,
    freezeOnInteract: options.countdown.freezeOnInteract,
  }
  return {
    id,
    sessionId,
    toolName: execution.name,
    ...(execution.callId === undefined ? {} : { callId: String(execution.callId) }),
    ...(options.title === undefined ? {} : { title: options.title }),
    layout: options.layout,
    labels: options.labels,
    fields,
    buttons: {
      ...options.buttons,
      feedback: {
        enabled: options.reject.feedback,
        ...(options.reject.feedbackPrompt === undefined ? {} : { prompt: options.reject.feedbackPrompt }),
        required: options.reject.requireFeedback,
      },
    },
    countdown,
    createdAt: now,
  }
}

/** Whether a decision carries a human edit of the proposal. */
export function isRevision(decision) {
  return decision.kind === 'modify' && decision.fields.length > 0
}

/**
 * Render the human's edited fields as text the model can act on.
 * @param decision - a modify decision.
 * @returns one block per changed field.
 */
export function revisionText(decision) {
  return decision.fields
    .map(entry => `- ${entry.param}:\n${entry.text}`)
    .join('\n')
}

/**
 * Fold one settled decision into the single message the model reads.
 * @param request - the request the human decided on.
 * @param decision - the normalized decision.
 * @param source - `user`, `timeout`, `abort`, or `host`.
 * @returns the model-facing reason text.
 */
export function describeDecision(request, decision, source) {
  const tool = JSON.stringify(request.toolName)
  if (source === 'timeout') {
    const seconds = Math.round((request.countdown?.remainingMs ?? 0) / 1000)
    if (decision.kind === 'approve') return `${REASON_PREFIX}: no human decision arrived within ${seconds}s, so tool ${tool} ran under the mount's timeout policy.`
    if (request.countdown?.action === 'notify') {
      return `${REASON_PREFIX}: no human decision arrived within ${seconds}s, so tool ${tool} did not run. Tell the user this call timed out and wait for an explicit instruction before running it.`
    }
    return `${REASON_PREFIX}: no human decision arrived within ${seconds}s, so tool ${tool} did not run (timeout policy: reject).`
  }
  if (source === 'abort' || source === 'host') {
    return `${REASON_PREFIX}: the decision for tool ${tool} was withdrawn before the user answered, so it did not run.`
  }
  if (decision.kind === 'modify') {
    return `${REASON_PREFIX}: the user revised the proposal, so tool ${tool} did not run. Re-issue the call with these changes:\n${revisionText(decision)}`
  }
  const feedback = decision.kind === 'reject' && typeof decision.feedback === 'string' && decision.feedback !== ''
    ? ` User feedback: ${decision.feedback}`
    : ''
  return `${REASON_PREFIX}: the user rejected tool ${tool} and it did not run.${feedback}`
}

/**
 * Fold one approved-with-edits decision into context the model reads alongside
 * the tool result (`modify.mode: allow-and-inform`).
 * @param request - the request the human approved.
 * @param decision - a modify decision.
 * @returns the follow-up text.
 */
export function revisionContext(request, decision) {
  return `${REASON_PREFIX}: the user approved tool ${JSON.stringify(request.toolName)} after editing the proposal. Their revised content:\n${revisionText(decision)}`
}

/** Cap one model-facing text at the protocol limit. */
export function capReason(text) {
  return truncate(text, LIMITS.maxDecisionChars).text
}
