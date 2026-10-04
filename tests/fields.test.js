import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REASON_PREFIX, buildFields, buildRequest, capReason, defaultFieldSpecs, describeDecision,
  hasComputed, inferRender, isRevision, renderValue, resolveFields, revisionContext, revisionText,
} from '../lib/fields.js'
import { LIMITS } from '../lib/protocol.js'
import { normalizeMount } from '../lib/resolve.js'

/** Normalize one mount through the same path the host half uses. */
function mountOf(input) {
  const normalized = normalizeMount({ tool: 'demo', ...input }, 'test')
  assert.equal(normalized.ok, true, normalized.warnings.join('; '))
  return normalized.mount
}

/** One pending execution with the schema shape `tools/pre-execute` hands over. */
function executionOf(argumentsValue, schema) {
  return {
    name: 'demo',
    callId: 'call_1',
    arguments: argumentsValue,
    ...(schema === undefined ? {} : { schema: { name: 'demo', parameters: schema } }),
  }
}

describe('fields: renderValue and inferRender', () => {
  it('passes strings through and pretty-prints other values', () => {
    assert.equal(renderValue('ls -la'), 'ls -la')
    assert.equal(renderValue({ a: 1 }), '{\n  "a": 1\n}')
    assert.equal(renderValue(3), '3')
    assert.equal(renderValue(undefined), '(undefined)')
    assert.equal(renderValue({ self: 1n }), '[object Object]')
  })

  it('defaults to the markdown box', () => {
    assert.equal(inferRender(), 'markdown')
  })
})

describe('fields: defaultFieldSpecs', () => {
  it('uses every parameter in argument order', () => {
    assert.deepEqual(defaultFieldSpecs(executionOf({ b: 1, a: 2 })), [{ param: 'b' }, { param: 'a' }])
  })

  it('falls back to one arguments field for empty or scalar arguments', () => {
    assert.deepEqual(defaultFieldSpecs(executionOf({})), [{ param: '(arguments)', render: 'json' }])
    assert.deepEqual(defaultFieldSpecs(executionOf('hello')), [{ param: '(arguments)', render: 'json' }])
    assert.deepEqual(defaultFieldSpecs(executionOf([1, 2])), [{ param: '(arguments)', render: 'json' }])
  })
})

describe('fields: buildFields defaults', () => {
  it('titles each field with the parameter key and takes schema help when present', () => {
    const fields = buildFields(executionOf({ command: 'ls -la', cwd: '/tmp' }, {
      command: { title: '命令', description: '要执行的命令' },
      cwd: { description: '工作目录' },
    }), mountOf({}))
    assert.deepEqual(fields, [
      {
        param: 'command',
        title: '命令',
        description: '要执行的命令',
        render: 'markdown',
        editable: true,
        labels: [],
        value: 'ls -la',
        truncated: false,
      },
      {
        param: 'cwd',
        title: 'cwd',
        description: '工作目录',
        render: 'markdown',
        editable: true,
        labels: [],
        value: '/tmp',
        truncated: false,
      },
    ])
  })

  it('renders non-string values as JSON text in an editable markdown box', () => {
    const [field] = buildFields(executionOf({ count: 3 }), mountOf({}))
    assert.equal(field.render, 'markdown')
    assert.equal(field.editable, true)
    assert.equal(field.value, '3')
  })

  it('shows the whole scalar argument when arguments are not a record', () => {
    const [field] = buildFields(executionOf('hello'), mountOf({}))
    assert.equal(field.param, '(arguments)')
    assert.equal(field.value, 'hello')
  })

  it('truncates a long value and says so', () => {
    const [field] = buildFields(executionOf({ body: 'x'.repeat(50) }), mountOf({ maxFieldChars: 5 }))
    assert.equal(field.truncated, true)
    assert.equal(field.value.startsWith('xxxxx'), true)
    assert.match(field.value, /已截断，共 50 字/)
  })

  it('sends no value for a hidden field', () => {
    const [field] = buildFields(executionOf({ secret: 'shh' }), mountOf({ fields: [{ param: 'secret', render: 'hidden' }] }))
    assert.deepEqual(field, { param: 'secret', title: 'secret', render: 'hidden', editable: false, labels: [], value: '', truncated: false })
  })
})

describe('fields: configured fields', () => {
  it('shows exactly the configured parameters', () => {
    const fields = buildFields(executionOf({ file_path: '/a', content: 'x', extra: 'y' }), mountOf({
      fields: ['file_path', { param: 'content', render: 'json' }],
    }))
    assert.deepEqual(fields.map(field => field.param), ['file_path', 'content'])
    assert.equal(fields[1].render, 'json')
    assert.equal(fields[1].editable, false)
  })

  it('pairs two parameters into one read-only diff and drops them from the list', () => {
    const fields = buildFields(executionOf({
      file_path: '/a.txt', old_string: 'one', new_string: 'two', extra: 'z',
    }), mountOf({ diff: { path: 'file_path', before: 'old_string', after: 'new_string' } }))
    assert.deepEqual(fields.map(field => field.param), ['file_path', 'extra', 'old_string→new_string'])
    const diff = fields[2]
    assert.equal(diff.render, 'diff')
    assert.equal(diff.editable, false)
    assert.deepEqual(diff.diff, { path: '/a.txt', oldText: 'one', newText: 'two' })
  })

  it('supports a field-level diff without a mount-level one', () => {
    const fields = buildFields(executionOf({ old: 'a', next: 'b' }), mountOf({
      fields: [{ param: 'content', render: 'diff', diff: { before: 'old', after: 'next' } }],
    }))
    assert.equal(fields.length, 1)
    assert.deepEqual(fields[0].diff, { path: undefined, oldText: 'a', newText: 'b' })
  })

  it('falls back to the arguments field when a configured list selects nothing', () => {
    const fields = buildFields(executionOf({ a: 1 }), mountOf({ fields: [] }))
    assert.deepEqual(fields, [{ param: '(arguments)', title: '(arguments)', render: 'json', editable: false, labels: [], value: '{}', truncated: false }])
  })
})

describe('fields: buildRequest', () => {
  it('carries the call identity, the defaults, and no empty title', () => {
    const request = buildRequest({
      execution: executionOf({ command: 'ls' }), mount: mountOf({}), sessionId: 's1', id: 'r1', now: 1000,
    })
    assert.deepEqual(request, {
      id: 'r1',
      sessionId: 's1',
      toolName: 'demo',
      callId: 'call_1',
      layout: 'stacked',
      labels: [],
      fields: [{
        param: 'command', title: 'command', render: 'markdown', editable: true, labels: [], value: 'ls', truncated: false,
      }],
      buttons: { feedback: { enabled: false, required: false } },
      countdown: null,
      createdAt: 1000,
    })
  })

  it('carries a countdown, label overrides, feedback settings, and a title', () => {
    const request = buildRequest({
      execution: executionOf({ command: 'ls' }),
      mount: mountOf({
        title: '确认执行',
        labels: ['不可撤销'],
        countdown: { seconds: 30 },
        reject: { feedback: true, feedbackPrompt: '为什么？', requireFeedback: true },
        labels2: undefined,
      }),
      sessionId: 's1',
      id: 'r1',
      now: 0,
    })
    assert.equal(request.title, '确认执行')
    assert.deepEqual(request.labels, ['不可撤销'])
    assert.deepEqual(request.countdown, { remainingMs: 30000, action: 'reject', freezeOnInteract: true })
    assert.deepEqual(request.buttons.feedback, { enabled: true, prompt: '为什么？', required: true })
  })

  it('carries the button label overrides a mount configured', () => {
    const request = buildRequest({
      execution: executionOf({ command: 'ls' }),
      mount: mountOf({ buttons: { approve: '同意', modify: '修改', reject: '拒绝' } }),
      sessionId: 's1',
      id: 'r1',
    })
    assert.deepEqual(request.buttons, {
      approve: '同意', modify: '修改', reject: '拒绝', feedback: { enabled: false, required: false },
    })
  })

  it('omits a call id the execution does not have', () => {
    const request = buildRequest({
      execution: { name: 'demo', arguments: {} }, mount: mountOf({}), sessionId: 's1', id: 'r1',
    })
    assert.equal('callId' in request, false)
  })
})

describe('fields: decisions back to the model', () => {
  const request = buildRequest({
    execution: executionOf({ command: 'ls' }),
    mount: mountOf({ countdown: { seconds: 30, action: 'notify' } }),
    sessionId: 's1',
    id: 'r1',
    now: 0,
  })

  it('recognizes a revision', () => {
    assert.equal(isRevision({ kind: 'modify', fields: [{ param: 'command', text: 'ls' }] }), true)
    assert.equal(isRevision({ kind: 'approve' }), false)
  })

  it('renders revision text per field', () => {
    assert.equal(revisionText({ kind: 'modify', fields: [{ param: 'a', text: '1' }, { param: 'b', text: '2' }] }), '- a:\n1\n- b:\n2')
  })

  it('reports a rejection with the user feedback verbatim', () => {
    const reason = describeDecision(request, { kind: 'reject', feedback: '太危险' }, 'user')
    assert.equal(reason.startsWith(`${REASON_PREFIX}: the user rejected tool "demo"`), true)
    assert.equal(reason.includes('User feedback: 太危险'), true)
  })

  it('omits the feedback sentence when the user typed none', () => {
    assert.equal(describeDecision(request, { kind: 'reject' }, 'user').includes('User feedback'), false)
  })

  it('turns a revision into a re-issue instruction', () => {
    const reason = describeDecision(request, { kind: 'modify', fields: [{ param: 'command', text: 'rm -rf /' }] }, 'user')
    assert.equal(reason.includes('Re-issue the call with these changes'), true)
    assert.equal(reason.includes('- command:\nrm -rf /'), true)
  })

  it('distinguishes the three timeout policies', () => {
    assert.equal(describeDecision(request, { kind: 'approve' }, 'timeout').includes("ran under the mount's timeout policy"), true)
    assert.equal(describeDecision(request, { kind: 'reject' }, 'timeout').includes('Tell the user this call timed out'), true)
    const strict = buildRequest({
      execution: executionOf({ command: 'ls' }),
      mount: mountOf({ countdown: { seconds: 10, action: 'reject' } }),
      sessionId: 's1',
      id: 'r2',
    })
    const reason = describeDecision(strict, { kind: 'reject' }, 'timeout')
    assert.equal(reason.includes('did not run'), true)
    assert.equal(reason.includes('timeout policy: reject'), true)
  })

  it('reports withdrawal for abort and host settlement', () => {
    assert.equal(describeDecision(request, { kind: 'cancel' }, 'abort').includes('withdrawn before the user answered'), true)
    assert.equal(describeDecision(request, { kind: 'cancel' }, 'host').includes('withdrawn before the user answered'), true)
  })

  it('reports an approval that carried edits', () => {
    const context = revisionContext(request, { kind: 'modify', fields: [{ param: 'command', text: 'ls -la' }] })
    assert.equal(context.includes('approved tool "demo" after editing the proposal'), true)
    assert.equal(context.includes('- command:\nls -la'), true)
  })

  it('caps a very long model-facing text', () => {
    const capped = capReason('x'.repeat(20000))
    assert.equal(capped.length < 20000, true)
    assert.equal(capped.includes('已截断'), true)
  })
})

describe('fields: computed fields', () => {
  const call = executionOf({ path: 'notes.md', content: 'new text' })

  it('takes a literal or a function as a field value', async () => {
    const mount = mountOf({
      fields: [
        { param: 'content', title: '正文', render: 'markdown', editable: false, value: execution => `读到 ${execution.arguments.path}` },
        { param: 'note', render: 'text', editable: false, value: '固定文案' },
        { param: 'path', render: 'text', editable: false },
      ],
    })
    const fields = buildFields(call, mount, await resolveFields(call, mount))
    assert.equal(fields[0].value, '读到 notes.md')
    assert.equal(fields[0].editable, false)
    assert.equal(fields[1].value, '固定文案')
    // A field without a resolver keeps reading its own argument.
    assert.equal(fields[2].value, 'notes.md')
  })

  it('awaits an async resolver and renders a non-string result', async () => {
    const mount = mountOf({
      fields: [
        { param: 'a', render: 'text', editable: false, value: async () => 'awaited' },
        { param: 'b', render: 'text', editable: false, value: () => ({ lines: 2 }) },
      ],
    })
    const fields = buildFields(call, mount, await resolveFields(call, mount))
    assert.equal(fields[0].value, 'awaited')
    assert.equal(fields[1].value, '{\n  "lines": 2\n}')
  })

  it('renders a computed diff against a literal path', async () => {
    const mount = mountOf({
      fields: [{
        param: 'index', title: '索引变化', render: 'diff', editable: false,
        diff: { path: 'index.md', before: async () => 'old line', after: 'content' },
      }],
    })
    const [field] = buildFields(call, mount, await resolveFields(call, mount))
    assert.equal(field.render, 'diff')
    assert.equal(field.editable, false)
    assert.deepEqual(field.diff, { path: 'index.md', oldText: 'old line', newText: 'new text' })
  })

  it('resolves a mount-level diff that carries no field list', async () => {
    const mount = mountOf({ diff: { path: () => 'tree.md', before: async () => 'a', after: () => 'b' } })
    const fields = buildFields(call, mount, await resolveFields(call, mount))
    assert.deepEqual(fields.map(field => field.param), ['path', 'content', 'computed→computed'])
    assert.deepEqual(fields[2].diff, { path: 'tree.md', oldText: 'a', newText: 'b' })
  })

  it('shows a failing resolver in its own field instead of blocking the gate', async () => {
    const mount = mountOf({
      fields: [
        { param: 'path', render: 'text', editable: false },
        { param: 'ghost', render: 'markdown', editable: false, value: () => { throw new Error('磁盘不可读') } },
      ],
    })
    const warnings = []
    const fields = buildFields(call, mount, await resolveFields(call, mount, { warn: message => warnings.push(message) }))
    assert.equal(fields[0].value, 'notes.md')
    assert.equal(fields[1].render, 'text')
    assert.equal(fields[1].editable, false)
    assert.equal(fields[1].value.includes('磁盘不可读'), true)
    assert.equal(warnings.length, 1)
  })

  it('bounds a hanging resolver with the mount timeout', async () => {
    const mount = mountOf({ resolveTimeoutMs: 20, fields: [{ param: 'slow', value: () => new Promise(() => {}) }] })
    const resolution = await resolveFields(call, mount, { timeoutMs: mount.options.resolveTimeoutMs })
    const [field] = buildFields(call, mount, resolution)
    assert.equal(field.value.includes('timed out after 20ms'), true)
  })

  it('truncates a computed value at maxFieldChars', async () => {
    const mount = mountOf({ maxFieldChars: 4, fields: [{ param: 'long', value: () => 'abcdefgh' }] })
    const [field] = buildFields(call, mount, await resolveFields(call, mount))
    assert.equal(field.truncated, true)
    assert.match(field.value, /已截断，共 8 字/)
  })

  it('bounds each side of a computed diff by lines', async () => {
    const long = Array.from({ length: LIMITS.maxDiffLines + 2 }, (_entry, index) => `L${index}`).join('\n')
    const mount = mountOf({
      fields: [{ param: 'big', render: 'diff', editable: false, diff: { before: () => '', after: () => long } }],
    })
    const [field] = buildFields(call, mount, await resolveFields(call, mount))
    assert.equal(field.diff.newText.split('\n').length, LIMITS.maxDiffLines + 1)
    assert.match(field.diff.newText, /已截断，另有 2 行未显示/)
  })

  it('leaves a mount without resolvers exactly as it was', async () => {
    const mount = mountOf({ fields: [{ param: 'content', render: 'markdown' }] })
    const resolution = await resolveFields(call, mount)
    assert.equal(resolution.fields.size, 0)
    assert.equal(resolution.mountDiff, undefined)
    assert.deepEqual(buildFields(call, mount, resolution), buildFields(call, mount))
  })

  it('reports which mounts compute a field', () => {
    assert.equal(hasComputed(mountOf({}).options), false)
    assert.equal(hasComputed(mountOf({ fields: [{ param: 'a', value: () => 'x' }] }).options), true)
    assert.equal(hasComputed(mountOf({ diff: { before: 'old', after: () => 'x' } }).options), true)
    assert.equal(hasComputed(mountOf({ fields: [{ param: 'a', diff: { before: 'old', after: () => 'x' } }] }).options), true)
  })

  it('carries a resolved diff through buildRequest', async () => {
    const mount = mountOf({
      fields: [{ param: 'index', title: '索引变化', render: 'diff', editable: false, diff: { path: 'index.md', before: () => 'old', after: 'content' } }],
    })
    const request = buildRequest({
      execution: call, mount, sessionId: 's1', id: 'r1', now: 0, resolution: await resolveFields(call, mount),
    })
    assert.deepEqual(request.fields[0].diff, { path: 'index.md', oldText: 'old', newText: 'new text' })
  })
})
