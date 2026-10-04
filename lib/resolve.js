/**
 * Mount resolution: tool matchers, option defaults, and the diagnostics that
 * turn a malformed mount into one warning row instead of a thrown load.
 *
 * A mount is what a plugin passes to `ctx.hitl.protect(matcher, options)` or a
 * user writes as one `config.protect` entry. Normalizing here keeps the gate
 * free of policy: it only ever asks "does this call match, and with what
 * options".
 */

import { LIMITS } from './protocol.js'

/** Panel layouts a mount may request. */
export const LAYOUTS = ['stacked', 'split']

/** What the human's modification means once the gate answers. */
export const MODIFY_MODES = ['revise-request', 'allow-and-inform']

/** What a countdown does when it reaches zero. */
export const TIMEOUT_ACTIONS = ['approve', 'reject', 'notify']

/** What a protected call does when no decision UI is connected. */
export const WHEN_UNAVAILABLE = ['reject', 'wait']

/** Field renderers the browser half knows. */
export const RENDER_MODES = ['markdown', 'text', 'diff', 'json', 'hidden']

/** Field renderers the human may edit. */
const EDITABLE_RENDERS = ['markdown', 'text']

/** Defaults one mount starts from; every key is restated by {@link normalizeMount}. */
export const DEFAULT_OPTIONS = {
  title: undefined,
  layout: 'stacked',
  labels: [],
  buttons: {},
  fields: undefined,
  diff: undefined,
  countdown: null,
  reject: { feedback: false, feedbackPrompt: undefined, requireFeedback: false },
  modify: { mode: 'revise-request' },
  whenUnavailable: 'reject',
  enabled: true,
  maxFieldChars: LIMITS.maxFieldChars,
}

/**
 * Turn one glob-ish tool pattern into an anchored regular expression.
 * `*` matches any run of characters; every other character is literal.
 * @param pattern - e.g. `mcp__*`.
 * @returns an anchored RegExp over tool names.
 */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, character => `\\${character}`)
  return new RegExp(`^${escaped.replaceAll('\\*', '.*')}$`)
}

/**
 * Compile any accepted matcher form into a test over one pending call.
 * @param matcher - tool name, glob string, name list, RegExp, or predicate over the execution.
 * @returns a predicate plus a stable description used by `ctx.hitl.list()`.
 * @throws {TypeError} when the matcher form is not one of the accepted ones.
 */
export function createMatcher(matcher) {
  if (typeof matcher === 'string') {
    if (matcher === '') throw new TypeError('hitl: a tool matcher must not be an empty string')
    if (matcher.includes('*')) {
      const pattern = globToRegExp(matcher)
      return { describe: matcher, test: execution => pattern.test(execution.name) }
    }
    return { describe: matcher, test: execution => execution.name === matcher }
  }
  if (matcher instanceof RegExp) {
    return { describe: String(matcher), test: execution => matcher.test(execution.name) }
  }
  if (Array.isArray(matcher)) {
    const compiled = matcher.map(entry => createMatcher(entry))
    return {
      describe: matcher.map(entry => `${String(entry)}`).join(', '),
      test: execution => compiled.some(entry => entry.test(execution)),
    }
  }
  if (typeof matcher === 'function') {
    return { describe: `predicate(${matcher.name || 'anonymous'})`, test: execution => matcher(execution) === true }
  }
  throw new TypeError('hitl: matcher must be a tool name, glob, RegExp, array, or predicate')
}

function normalizeCountdown(value, report) {
  if (value === undefined || value === null || value === false) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    report('countdown must be an object like { seconds, action }')
    return null
  }
  const seconds = value.seconds
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    report('countdown.seconds must be a positive integer number of seconds')
    return null
  }
  const action = value.action ?? 'reject'
  if (!TIMEOUT_ACTIONS.includes(action)) {
    report(`countdown.action must be one of ${TIMEOUT_ACTIONS.join(', ')}`)
    return null
  }
  return {
    seconds,
    action,
    freezeOnInteract: value.freezeOnInteract !== false,
  }
}

function normalizeReject(value, report) {
  if (value === undefined || value === null) return { ...DEFAULT_OPTIONS.reject }
  if (typeof value !== 'object' || Array.isArray(value)) {
    report('reject must be an object like { feedback: true }')
    return { ...DEFAULT_OPTIONS.reject }
  }
  return {
    feedback: value.feedback === true,
    feedbackPrompt: typeof value.feedbackPrompt === 'string' ? value.feedbackPrompt : undefined,
    requireFeedback: value.requireFeedback === true,
  }
}

function normalizeModify(value, report) {
  if (value === undefined || value === null) return { ...DEFAULT_OPTIONS.modify }
  if (typeof value !== 'object' || Array.isArray(value)) {
    report('modify must be an object like { mode: "revise-request" }')
    return { ...DEFAULT_OPTIONS.modify }
  }
  const mode = value.mode ?? 'revise-request'
  if (!MODIFY_MODES.includes(mode)) {
    report(`modify.mode must be one of ${MODIFY_MODES.join(', ')}`)
    return { ...DEFAULT_OPTIONS.modify }
  }
  return { mode }
}

/** Button copy a mount may override; the browser localizes every label it leaves unset. */
function normalizeButtons(value, report) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    report('buttons must be an object like { approve: "同意", reject: "拒绝" }')
    return {}
  }
  const buttons = {}
  for (const key of ['approve', 'modify', 'reject']) {
    if (typeof value[key] === 'string' && value[key] !== '') buttons[key] = value[key]
  }
  return buttons
}

function normalizeField(entry, report, index) {
  if (typeof entry === 'string') return { param: entry }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    report(`fields[${index}] must be a parameter name or an object`)
    return undefined
  }
  if (typeof entry.param !== 'string' || entry.param === '') {
    report(`fields[${index}].param must be a non-empty parameter name`)
    return undefined
  }
  if (entry.render !== undefined && !RENDER_MODES.includes(entry.render)) {
    report(`fields[${index}].render must be one of ${RENDER_MODES.join(', ')}`)
    return undefined
  }
  return {
    param: entry.param,
    ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
    ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    ...(entry.render === undefined ? {} : { render: entry.render }),
    ...(entry.editable === undefined ? {} : { editable: entry.editable === true }),
    ...(Array.isArray(entry.labels) ? { labels: entry.labels.filter(label => typeof label === 'string') } : {}),
    ...(entry.diff === undefined ? {} : { diff: entry.diff }),
  }
}

/**
 * Validate and complete one mount.
 * @param input - `{ tool, ...options }`, the row form; or `{ matcher, options }`, the API form.
 * @param source - stable label for diagnostics (`config.protect[0]`, `hitl.protect()`).
 * @returns `{ ok: true, mount }` or `{ ok: false, warnings }`.
 */
export function normalizeMount(input, source) {
  const warnings = []
  const report = message => { warnings.push(`${source}: ${message}`) }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    report('a mount must be an object')
    return { ok: false, warnings }
  }
  const rawMatcher = input.matcher ?? input.tool
  let matcher
  try {
    matcher = createMatcher(rawMatcher)
  } catch (error) {
    report(error instanceof Error ? error.message : String(error))
    return { ok: false, warnings }
  }
  const layout = input.layout ?? DEFAULT_OPTIONS.layout
  if (!LAYOUTS.includes(layout)) report(`layout must be one of ${LAYOUTS.join(', ')}`)
  const whenUnavailable = input.whenUnavailable ?? DEFAULT_OPTIONS.whenUnavailable
  if (!WHEN_UNAVAILABLE.includes(whenUnavailable)) {
    report(`whenUnavailable must be one of ${WHEN_UNAVAILABLE.join(', ')}`)
  }
  const fields = input.fields === undefined
    ? undefined
    : (Array.isArray(input.fields) ? input.fields : [])
      .map((entry, index) => normalizeField(entry, report, index))
      .filter(entry => entry !== undefined)
  if (input.fields !== undefined && !Array.isArray(input.fields)) {
    report('fields must be an array of parameter names or field objects')
  }
  const maxFieldChars = Number.isSafeInteger(input.maxFieldChars) && input.maxFieldChars > 0
    ? input.maxFieldChars
    : DEFAULT_OPTIONS.maxFieldChars
  const labels = Array.isArray(input.labels)
    ? input.labels.filter(label => typeof label === 'string' && label !== '')
    : []
  const countdown = normalizeCountdown(input.countdown, report)
  const unavailable = WHEN_UNAVAILABLE.includes(whenUnavailable)
    ? whenUnavailable
    : DEFAULT_OPTIONS.whenUnavailable
  // `wait` is fail-open by design: with no browser attached the call sits there
  // until something ends it. Without a countdown, "something" means the session
  // or the plugin, so an unattended run blocks an agent for as long as it lives.
  // Say so at mount time rather than letting the first unattended run discover it.
  if (unavailable === 'wait' && countdown === null) {
    report('whenUnavailable: wait without a countdown blocks an unattended call until its session ends; pair it with countdown.seconds or use the fail-closed default')
  }
  const mount = {
    describe: matcher.describe,
    test: matcher.test,
    options: {
      title: typeof input.title === 'string' ? input.title : undefined,
      layout: LAYOUTS.includes(layout) ? layout : DEFAULT_OPTIONS.layout,
      labels,
      buttons: normalizeButtons(input.buttons, report),
      fields,
      diff: input.diff,
      countdown,
      reject: normalizeReject(input.reject, report),
      modify: normalizeModify(input.modify, report),
      whenUnavailable: unavailable,
      enabled: input.enabled === undefined ? true : input.enabled,
      maxFieldChars,
    },
  }
  return { ok: true, mount, warnings }
}

/**
 * Normalize a whole `config.protect` list, keeping the valid rows.
 * @param entries - the row's raw list.
 * @param source - label prefix for diagnostics.
 * @returns `{ mounts, warnings }`.
 */
export function normalizeProtectList(entries, source = 'config.protect') {
  const mounts = []
  const warnings = []
  if (entries === undefined) return { mounts, warnings }
  if (!Array.isArray(entries)) {
    warnings.push(`${source} must be an array of { tool, ...options } entries`)
    return { mounts, warnings }
  }
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeMount(entry, `${source}[${index}]`)
    warnings.push(...normalized.warnings)
    if (normalized.ok) mounts.push(normalized.mount)
  }
  return { mounts, warnings }
}

/**
 * Find the mount that owns one call. The most recently registered match wins,
 * so a plugin mounting a tool after the row config overrides the row.
 * @param mounts - registered mounts in registration order.
 * @param execution - the pending tool execution.
 * @returns the winning mount, or undefined.
 */
export function matchMount(mounts, execution) {
  for (let index = mounts.length - 1; index >= 0; index -= 1) {
    const mount = mounts[index]
    if (mount.test(execution)) return mount
  }
  return undefined
}

/**
 * Resolve whether a mount protects this call right now.
 * @param mount - the matched mount.
 * @param execution - the pending tool execution.
 * @returns whether the gate must ask.
 */
export function mountApplies(mount, execution) {
  const enabled = mount.options.enabled
  if (enabled === undefined || enabled === true) return true
  if (enabled === false) return false
  if (typeof enabled === 'function') {
    try {
      return enabled(execution) === true
    } catch {
      return false
    }
  }
  return false
}

/** Whether a render mode is editable by default. */
export function defaultEditable(render) {
  return EDITABLE_RENDERS.includes(render)
}
