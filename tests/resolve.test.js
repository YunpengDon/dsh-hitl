import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_OPTIONS, createMatcher, defaultEditable, globToRegExp, matchMount, mountApplies,
  normalizeMount, normalizeProtectList,
} from '../lib/resolve.js'

describe('resolve: globToRegExp', () => {
  it('anchors the pattern and expands the star', () => {
    const pattern = globToRegExp('mcp__*')
    assert.equal(pattern.test('mcp__foo'), true)
    assert.equal(pattern.test('xmcp__foo'), false)
    assert.equal(pattern.test('mcp__'), true)
  })

  it('keeps every other character literal', () => {
    const pattern = globToRegExp('a.b*')
    assert.equal(pattern.test('a.bX'), true)
    assert.equal(pattern.test('axbX'), false)
  })
})

describe('resolve: createMatcher', () => {
  it('matches an exact name', () => {
    assert.equal(createMatcher('bash').test({ name: 'bash' }), true)
    assert.equal(createMatcher('bash').test({ name: 'bash2' }), false)
  })

  it('treats a star as a wildcard', () => {
    assert.equal(createMatcher('mcp__*').test({ name: 'mcp__files' }), true)
  })

  it('supports a RegExp, a list, and a predicate', () => {
    assert.equal(createMatcher(/^read/).test({ name: 'read_image' }), true)
    assert.equal(createMatcher(['a', 'b*']).test({ name: 'banana' }), true)
    assert.equal(createMatcher(execution => execution.name === 'z').test({ name: 'z' }), true)
  })

  it('rejects an empty string and an unsupported form', () => {
    assert.throws(() => createMatcher(''), TypeError)
    assert.throws(() => createMatcher(7), TypeError)
  })
})

describe('resolve: normalizeMount', () => {
  it('fills every default for a minimal row entry', () => {
    const { ok, mount } = normalizeMount({ tool: 'bash' }, 'config.protect[0]')
    assert.equal(ok, true)
    assert.equal(mount.describe, 'bash')
    assert.deepEqual(mount.options, {
      title: undefined,
      layout: DEFAULT_OPTIONS.layout,
      labels: [],
      buttons: {},
      fields: undefined,
      diff: undefined,
      countdown: null,
      reject: { feedback: false, feedbackPrompt: undefined, requireFeedback: false },
      modify: { mode: 'revise-request' },
      whenUnavailable: 'reject',
      enabled: true,
      maxFieldChars: DEFAULT_OPTIONS.maxFieldChars,
      resolveTimeoutMs: DEFAULT_OPTIONS.resolveTimeoutMs,
    })
  })

  it('keeps a valid countdown and normalizes its action', () => {
    const { mount } = normalizeMount({ tool: 'bash', countdown: { seconds: 30 } }, 'src')
    assert.deepEqual(mount.options.countdown, { seconds: 30, action: 'reject', freezeOnInteract: true })
    const notify = normalizeMount({ tool: 'bash', countdown: { seconds: 5, action: 'notify', freezeOnInteract: false } }, 'src')
    assert.deepEqual(notify.mount.options.countdown, { seconds: 5, action: 'notify', freezeOnInteract: false })
  })

  it('warns and drops an invalid countdown instead of throwing', () => {
    const { ok, mount, warnings } = normalizeMount({ tool: 'bash', countdown: { seconds: 0 } }, 'src')
    assert.equal(ok, true)
    assert.equal(mount.options.countdown, null)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /countdown.seconds/)
  })

  it('warns when a mount waits forever with nothing to end the wait', () => {
    // Fail-open plus no deadline is legal, and it blocks an unattended call for
    // as long as its session lives. The mount is still installed; the warning is
    // the whole point, because the first unattended run must not be the discovery.
    const open = normalizeMount({ tool: 'bash', whenUnavailable: 'wait' }, 'src')
    assert.equal(open.ok, true)
    assert.equal(open.mount.options.whenUnavailable, 'wait')
    assert.equal(open.warnings.length, 1)
    assert.match(open.warnings[0], /whenUnavailable: wait without a countdown/)

    // A deadline is what bounds it, so the pairing is silent — and so is the
    // fail-closed default, which needs no deadline to be safe.
    const bounded = normalizeMount({ tool: 'bash', whenUnavailable: 'wait', countdown: { seconds: 300, action: 'reject' } }, 'src')
    assert.equal(bounded.warnings.length, 0)
    const closed = normalizeMount({ tool: 'bash' }, 'src')
    assert.equal(closed.mount.options.whenUnavailable, 'reject')
    assert.equal(closed.warnings.length, 0)
  })

  it('normalizes field entries and drops invalid ones', () => {
    const { mount, warnings } = normalizeMount({
      tool: 'edit',
      fields: ['file_path', { param: 'content', title: '新内容', render: 'text', editable: true, labels: ['不可撤销'] }, { param: 'x', render: 'nope' }],
    }, 'src')
    assert.deepEqual(mount.options.fields, [
      { param: 'file_path' },
      { param: 'content', title: '新内容', render: 'text', editable: true, labels: ['不可撤销'] },
    ])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /fields\[2\]\.render/)
  })

  it('keeps a literal or computed field value and drops an unusable one', () => {
    const read = () => 'value'
    const { mount, warnings } = normalizeMount({
      tool: 'edit',
      fields: [
        { param: 'note', value: '固定文案' },
        { param: 'computed', value: read },
        { param: 'content', value: undefined, diff: { path: 'file_path', before: read, after: 'new_string' } },
      ],
    }, 'src')
    assert.equal(mount.options.fields[0].value, '固定文案')
    assert.equal(mount.options.fields[1].value, read)
    assert.deepEqual(Object.keys(mount.options.fields[2].diff), ['before', 'after', 'path'])
    assert.equal(mount.options.fields[2].diff.before, read)
    assert.equal(warnings.length, 0)

    const bad = normalizeMount({ tool: 'edit', fields: [{ param: 'x', value: 7 }] }, 'src')
    assert.deepEqual(bad.mount.options.fields, [])
    assert.equal(bad.warnings.length, 1)
    assert.match(bad.warnings[0], /fields\[0\]\.value/)
  })

  it('drops a malformed diff instead of letting the field render as markdown', () => {
    const bad = normalizeMount({ tool: 'edit', diff: { before: 'old_string' } }, 'src')
    assert.equal(bad.mount.options.diff, undefined)
    assert.equal(bad.warnings.length, 1)
    assert.match(bad.warnings[0], /^src: diff\.before and diff\.after/)

    const fieldLevel = normalizeMount({
      tool: 'edit', fields: [{ param: 'x', diff: { before: 'a', after: 'b', path: 7 } }],
    }, 'src')
    assert.equal('diff' in fieldLevel.mount.options.fields[0], false)
    assert.equal(fieldLevel.warnings.length, 1)
    assert.match(fieldLevel.warnings[0], /fields\[0\]\.diff\.path/)
  })

  it('bounds a computed field with resolveTimeoutMs, defaulting from the protocol', () => {
    assert.equal(normalizeMount({ tool: 'bash' }, 'src').mount.options.resolveTimeoutMs, DEFAULT_OPTIONS.resolveTimeoutMs)
    assert.equal(normalizeMount({ tool: 'bash', resolveTimeoutMs: 250 }, 'src').mount.options.resolveTimeoutMs, 250)
    assert.equal(normalizeMount({ tool: 'bash', resolveTimeoutMs: 0 }, 'src').mount.options.resolveTimeoutMs, DEFAULT_OPTIONS.resolveTimeoutMs)
  })

  it('reports a bad layout, unavailable policy, and modify mode', () => {
    const { mount, warnings } = normalizeMount({
      tool: 'bash', layout: 'grid', whenUnavailable: 'maybe', modify: { mode: 'ignore' }, maxFieldChars: -1, labels: ['ok', 3],
    }, 'src')
    assert.equal(mount.options.layout, 'stacked')
    assert.equal(mount.options.whenUnavailable, 'reject')
    assert.deepEqual(mount.options.modify, { mode: 'revise-request' })
    assert.equal(mount.options.maxFieldChars, DEFAULT_OPTIONS.maxFieldChars)
    assert.deepEqual(mount.options.labels, ['ok'])
    assert.equal(warnings.length, 3)
  })

  it('fails without a usable matcher', () => {
    assert.equal(normalizeMount({}, 'src').ok, false)
    assert.equal(normalizeMount('bash', 'src').ok, false)
    assert.equal(normalizeMount({ tool: '' }, 'src').ok, false)
  })

  it('accepts the API matcher form', () => {
    const { mount } = normalizeMount({ matcher: /^read/, options: {} }, 'hitl.protect()')
    assert.equal(mount.describe, String(/^read/))
  })
})

describe('resolve: normalizeProtectList', () => {
  it('keeps valid rows and reports the rest', () => {
    const { mounts, warnings } = normalizeProtectList([
      { tool: 'bash' }, { tool: '' }, 'nope', { tool: 'read', countdown: { seconds: -1 } },
    ])
    assert.deepEqual(mounts.map(mount => mount.describe), ['bash', 'read'])
    assert.equal(warnings.length, 3)
  })

  it('warns when the list itself is malformed', () => {
    assert.equal(normalizeProtectList({ tool: 'bash' }).warnings.length, 1)
    assert.deepEqual(normalizeProtectList(undefined), { mounts: [], warnings: [] })
  })
})

describe('resolve: match and applicability', () => {
  it('lets the most recent mount win', () => {
    const first = normalizeMount({ tool: 'bash', title: 'first' }, 'a').mount
    const second = normalizeMount({ tool: 'bash', title: 'second' }, 'b').mount
    assert.equal(matchMount([first, second], { name: 'bash' }).options.title, 'second')
    assert.equal(matchMount([first], { name: 'other' }), undefined)
  })

  it('honours enabled as a boolean, a predicate, and a throwing predicate', () => {
    const base = normalizeMount({ tool: 'bash' }, 'a').mount
    assert.equal(mountApplies(base, { name: 'bash' }), true)
    assert.equal(mountApplies({ options: { enabled: false } }, {}), false)
    assert.equal(mountApplies({ options: { enabled: execution => execution.name === 'bash' } }, { name: 'bash' }), true)
    assert.equal(mountApplies({ options: { enabled: execution => execution.name === 'bash' } }, { name: 'zsh' }), false)
    assert.equal(mountApplies({ options: { enabled: () => { throw new Error('boom') } } }, {}), false)
    assert.equal(mountApplies({ options: { enabled: 'yes' } }, {}), false)
    assert.equal(mountApplies({ options: {} }, {}), true)
  })
})

describe('resolve: defaultEditable', () => {
  it('makes text and markdown editable, everything else read-only', () => {
    assert.equal(defaultEditable('markdown'), true)
    assert.equal(defaultEditable('text'), true)
    assert.equal(defaultEditable('diff'), false)
    assert.equal(defaultEditable('json'), false)
    assert.equal(defaultEditable('hidden'), false)
  })
})
