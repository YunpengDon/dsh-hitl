/**
 * Proposal construction: turning one pending tool execution plus its mount into
 * the wire request the browser renders, and turning a human decision back into
 * the text the model reads.
 *
 * Defaults follow the plugin's core promise: with no configuration at all, the
 * proposal is the call's own parameters — one field per parameter, titled by the
 * parameter's key, rendered as an editable markdown box.
 */

import { LIMITS, truncate } from './protocol.js'
import { defaultEditable } from './resolve.js'

/** Model-facing prefix every reason this plugin produces starts with. */
export const REASON_PREFIX = 'HITL'

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
  const requested = spec.diff ?? mount.options.diff
  if (requested === undefined || requested === null || typeof requested !== 'object') return undefined
  const before = requested.before
  const after = requested.after
  if (typeof before !== 'string' || typeof after !== 'string') return undefined
  const args = argumentsOf(execution)
  if (args === undefined) return undefined
  return {
    path: typeof requested.path === 'string' ? renderValue(args[requested.path]) : undefined,
    oldText: renderValue(args[before]),
    newText: renderValue(args[after]),
  }
}

/**
 * Build the wire fields of one request.
 * @param execution - the pending tool execution.
 * @param mount - the matched mount.
 * @returns an ordered field array, values already rendered and truncated.
 */
export function buildFields(execution, mount) {
  const options = mount.options
  const args = argumentsOf(execution)
  const mountDiff = options.diff === undefined || options.diff === null ? undefined : options.diff
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
    const render = spec.render ?? (diffSpec(spec, mount, execution) === undefined ? inferRender(raw) : 'diff')
    const diff = render === 'diff' ? diffSpec(spec, mount, execution) : undefined
    const title = spec.title
      ?? (typeof schema?.title === 'string' ? schema.title : undefined)
      ?? param
    const description = spec.description
      ?? (typeof schema?.description === 'string' ? schema.description : undefined)
    const editable = spec.editable ?? defaultEditable(render)
    // A hidden field carries no value: it exists only to stay out of the panel.
    const value = diff === undefined && render !== 'hidden'
      ? truncate(renderValue(raw), options.maxFieldChars)
      : { text: '', truncated: false }
    fields.push({
      param,
      title,
      ...(description === undefined ? {} : { description }),
      render,
      editable: render === 'diff' || render === 'hidden' ? false : editable,
      labels: spec.labels ?? [],
      ...(diff === undefined ? { value: value.text, truncated: value.truncated } : { diff }),
    })
  }
  if (options.fields === undefined && mountDiff !== undefined) {
    const diff = diffSpec({ diff: mountDiff }, mount, execution)
    if (diff !== undefined) {
      fields.push({
        param: `${options.diff.before}→${options.diff.after}`,
        title: typeof options.diff.title === 'string' ? options.diff.title : 'diff',
        render: 'diff',
        editable: false,
        labels: [],
        diff,
      })
    }
  }
  if (fields.length === 0) {
    return [{ param: '(arguments)', title: '(arguments)', render: 'json', editable: false, labels: [], value: '{}', truncated: false }]
  }
  return fields
}

/**
 * Build one complete wire request.
 * @param input - `{ execution, mount, sessionId, id, now }`.
 * @returns the request object broadcast to browsers.
 */
export function buildRequest({ execution, mount, sessionId, id, now = Date.now() }) {
  const options = mount.options
  const fields = buildFields(execution, mount)
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
