import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Load `client.js` the way the browser module table does — through
 * `window.__ModuleLoader__` with a stubbed `require` — and take the pure
 * helpers the factory exposes for tests.
 */
async function loadClient() {
  let plugin
  const react = {
    createElement: () => ({ type: 'stub' }),
    Component: class Component {
      constructor(props) { this.props = props }
    },
    useMemo: callback => callback(),
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: () => ({}),
  }
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        plugin = definition.factory(name => {
          if (name === 'react') return react
          return {}
        })
      },
    },
  }
  const here = dirname(fileURLToPath(import.meta.url))
  await import(pathToFileURL(join(here, '..', 'client.js')).href)
  return plugin.__test
}

const client = await loadClient()

describe('client: escaping and markdown', () => {
  it('escapes every HTML-significant character', () => {
    assert.equal(client.escapeHtml('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;')
    assert.equal(client.escapeHtml("it's"), 'it&#39;s')
  })

  it('renders the supported block forms', () => {
    const html = client.renderMarkdownHtml(['# Title', '', '- one', '- two', '', '> quoted', '', '```js', 'const a = 1', '```'].join('\n'))
    assert.equal(html.includes('<h3 class="dsh-hitl-h">Title</h3>'), true)
    assert.equal(html.includes('<ul class="dsh-hitl-list"><li>one</li><li>two</li></ul>'), true)
    assert.equal(html.includes('<blockquote class="dsh-hitl-quote">quoted</blockquote>'), true)
    assert.equal(html.includes('data-lang="js"'), true)
    assert.equal(html.includes('const a = 1'), true)
  })

  it('renders the supported inline forms', () => {
    const html = client.renderMarkdownHtml('a **bold** and *em* and `code` and [link](https://example.com)')
    assert.equal(html.includes('<strong>bold</strong>'), true)
    assert.equal(html.includes('<em>em</em>'), true)
    assert.equal(html.includes('<code class="dsh-hitl-code">code</code>'), true)
    assert.equal(html.includes('href="https://example.com"'), true)
  })

  it('never emits markup from the source text', () => {
    const html = client.renderMarkdownHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>')
    assert.equal(html.includes('<script>'), false)
    assert.equal(html.includes('<img'), false)
    assert.equal(html.includes('&lt;script&gt;'), true)
  })

  it('drops unsafe link targets', () => {
    const html = client.renderMarkdownHtml('[click](javascript:alert(1))')
    assert.equal(html.includes('<a '), false)
    assert.equal(html.includes('javascript:alert(1)'), true)
  })

  it('handles an empty document', () => {
    assert.equal(client.renderMarkdownHtml(''), '')
  })
})

describe('client: diff', () => {
  it('aligns equal lines and marks the change', () => {
    const diff = client.diffLines('a\nb\nc', 'a\nB\nc')
    assert.equal(diff.added, 1)
    assert.equal(diff.removed, 1)
    assert.deepEqual(diff.rows.map(row => row.type), ['same', 'removed', 'added', 'same'])
    assert.equal(diff.rows[1].left.text, 'b')
    assert.equal(diff.rows[2].right.text, 'B')
  })

  it('reports pure additions and removals', () => {
    const added = client.diffLines('', 'x\ny')
    assert.equal(added.added, 2)
    assert.equal(added.removed, 0)
    const removed = client.diffLines('x\ny', '')
    assert.equal(removed.removed, 2)
    assert.equal(removed.added, 0)
  })

  it('refuses to align an oversized side', () => {
    const huge = Array.from({ length: 2500 }, (_value, index) => `line ${index}`).join('\n')
    assert.equal(client.diffLines(huge, 'small'), undefined)
  })
})

describe('client: countdown and button label', () => {
  it('rounds the remaining time up to whole seconds', () => {
    assert.equal(client.formatRemaining(0), '0')
    assert.equal(client.formatRemaining(1), '1')
    assert.equal(client.formatRemaining(1400), '2')
    assert.equal(client.formatRemaining(-500), '0')
  })

  it('turns Approve into Modify once a field was edited', () => {
    const request = { buttons: {} }
    const t = key => key
    assert.equal(client.primaryLabel(false, request, t), 'button.approve')
    assert.equal(client.primaryLabel(true, request, t), 'button.modify')
    assert.equal(client.primaryLabel(true, { buttons: { modify: '改一下' } }, t), '改一下')
  })

  it('never makes a read-only field accept input', () => {
    assert.equal(client.isFieldEditable({ editable: true }, true), true)
    assert.equal(client.isFieldEditable({ editable: false }, true), false)
    assert.equal(client.isFieldEditable({}, true), false)
    assert.equal(client.isFieldEditable(undefined, true), false)
    assert.equal(client.isFieldEditable({ editable: true }, false), false)
  })

  it('collects only editable fields whose text changed', () => {
    const fields = [
      { param: 'a', editable: true, value: 'one' },
      { param: 'b', editable: false, value: 'two' },
      { param: 'c', editable: true, value: 'three' },
    ]
    assert.deepEqual(client.changedFields(fields, { a: 'one', c: 'three' }), [])
    assert.deepEqual(client.changedFields(fields, { a: 'one!', b: 'ignored', c: 'three' }), [{ param: 'a', text: 'one!' }])
    assert.deepEqual(client.changedFields(fields, {}), [])
  })
})

describe('client: store', () => {
  it('publishes snapshots and keeps a stable reference when nothing changed', () => {
    const store = client.createStore()
    const seen = []
    const stop = store.subscribe(() => { seen.push(store.getSnapshot()) })
    const first = store.getSnapshot()
    assert.equal(first.connection, 'connecting')
    store.setConnection('open')
    store.setConnection('open')
    assert.equal(seen.length, 1)
    assert.equal(store.getSnapshot().connection, 'open')
    store.upsert({ id: 'r1', sessionId: 's1' })
    assert.equal(store.request('r1').sessionId, 's1')
    store.upsert({ id: 'r1', sessionId: 's1', title: 'later' })
    assert.equal(store.getSnapshot().requests.length, 1)
    assert.equal(store.request('r1').title, 'later')
    store.replace([{ id: 'r2', sessionId: 's1' }])
    assert.deepEqual(store.getSnapshot().requests.map(request => request.id), ['r2'])
    store.settle('r2', 'timeout')
    assert.deepEqual(store.getSnapshot().requests, [])
    assert.equal(store.getSnapshot().settled.r2, 'timeout')
    store.remove('gone')
    stop()
    store.setConnection('closed')
    assert.equal(seen.length, 6)
  })
})

describe('client: connection', () => {
  /** One stubbed browser environment for the connection tests. */
  function withBrowser(run, responder) {
    const events = []
    const posts = []
    class FakeEventSource {
      constructor(url) {
        this.url = url
        this.readyState = 1
        events.push(this)
      }

      close() { this.readyState = 2 }
    }
    const previous = {
      EventSource: globalThis.EventSource,
      fetch: globalThis.fetch,
    }
    globalThis.EventSource = FakeEventSource
    globalThis.fetch = async (url, init) => {
      posts.push({ url, init })
      if (responder !== undefined) return responder(url, init)
      return { ok: true, status: 200, json: async () => ({ ok: true, accepted: true }) }
    }
    try {
      return run({ events, posts, FakeEventSource })
    } finally {
      globalThis.EventSource = previous.EventSource
      globalThis.fetch = previous.fetch
    }
  }

  it('reports an unavailable channel without a token', async () => {
    const store = client.createStore()
    const connection = client.createConnection({ boot: undefined, store })
    connection.start()
    assert.equal(store.getSnapshot().connection, 'unavailable')
    await assert.rejects(() => connection.decide('r1', { kind: 'approve' }), /unavailable/)
  })

  it('streams frames into the store and posts decisions with the bearer token', async () => {
    await withBrowser(async ({ events, posts }) => {
      const store = client.createStore()
      const connection = client.createConnection({ boot: { token: 'tok', endpoint: '/dsh-hitl' }, store })
      connection.start()
      assert.equal(events.length, 1)
      assert.equal(events[0].url, '/dsh-hitl/events?token=tok')
      events[0].onopen()
      assert.equal(store.getSnapshot().connection, 'open')
      events[0].onmessage({ data: JSON.stringify({ type: 'snapshot', requests: [{ id: 'r1', sessionId: 's1' }] }) })
      assert.deepEqual(store.getSnapshot().requests.map(request => request.id), ['r1'])
      events[0].onmessage({ data: JSON.stringify({ type: 'request', request: { id: 'r2', sessionId: 's1' } }) })
      assert.deepEqual(store.getSnapshot().requests.map(request => request.id), ['r1', 'r2'])
      events[0].onmessage({ data: JSON.stringify({ type: 'settled', id: 'r1', outcome: 'timeout' }) })
      // A timeout is nobody's decision, so it stays readable for a moment with
      // the outcome recorded instead of disappearing the instant it fires.
      assert.deepEqual(store.getSnapshot().requests.map(request => request.id), ['r1', 'r2'])
      assert.equal(store.getSnapshot().outcomes.r1, 'timeout')
      events[0].onmessage({ data: JSON.stringify({ type: 'settled', id: 'r1', outcome: 'user' }) })
      assert.deepEqual(store.getSnapshot().requests.map(request => request.id), ['r2'], 'a human outcome closes it at once')
      events[0].onmessage({ data: 'not json' })
      assert.equal(store.getSnapshot().requests.length, 1)
      await connection.decide('r2', { kind: 'reject', feedback: 'no' })
      assert.equal(posts[0].url, '/dsh-hitl/decide')
      assert.deepEqual(JSON.parse(posts[0].init.body), { type: 'decide', id: 'r2', decision: { kind: 'reject', feedback: 'no' } })
      assert.equal(posts[0].init.headers.authorization, 'Bearer tok')
      connection.dispose()
      assert.equal(events[0].readyState, 2)
    })
  })

  it('surfaces the host message when a decision is refused', async () => {
    await withBrowser(async ({ events, posts }) => {
      const store = client.createStore()
      const connection = client.createConnection({ boot: { token: 'tok', endpoint: '/dsh-hitl' }, store })
      connection.start()
      await assert.rejects(() => connection.decide('r1', { kind: 'approve' }), /no longer open/)
      assert.equal(posts.length, 1)
      events[0].readyState = 0
      events[0].onerror()
      assert.equal(store.getSnapshot().connection, 'connecting')
      events[0].readyState = 2
      events[0].onerror()
      assert.equal(store.getSnapshot().connection, 'unavailable')
      events[0].onopen()
      assert.equal(store.getSnapshot().connection, 'open')
      connection.dispose()
    }, () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, code: 'already-settled', message: 'that decision is no longer open' }),
    }))
  })

  it('swallows hold failures so editing never blocks the panel', async () => {
    await withBrowser(async ({ events }) => {
      const store = client.createStore()
      const connection = client.createConnection({ boot: { token: 'tok', endpoint: '/dsh-hitl' }, store })
      connection.start()
      assert.equal(await connection.hold('r1', true), undefined)
      events[0].onmessage({ data: JSON.stringify({ type: 'holdAck', id: 'r1', held: true }) })
      connection.dispose()
    }, () => { throw new Error('offline') })
  })
})

describe('client: dictionaries', () => {
  it('keeps the two locales on the same key set', () => {
    assert.deepEqual(Object.keys(client.zh).sort(), Object.keys(client.en).sort())
  })
})

describe('client: countdown emphasis and holds', () => {
  it('escalates the countdown as the deadline approaches', () => {
    assert.equal(client.countdownTone(120000, false, false), 'normal')
    assert.equal(client.countdownTone(10001, false, false), 'normal')
    assert.equal(client.countdownTone(10000, false, false), 'warn')
    assert.equal(client.countdownTone(1200, false, false), 'warn')
    assert.equal(client.countdownTone(1200, true, false), 'held')
    assert.equal(client.countdownTone(0, false, true), 'timeout')
    assert.equal(client.countdownTone(undefined, false, false), 'normal')
  })

  it('tracks the host verdict on interaction holds', () => {
    const store = client.createStore()
    const seen = []
    const stop = store.subscribe(() => { seen.push(store.getSnapshot()) })
    assert.deepEqual(store.getSnapshot().holds, {})
    store.setHold('r1', true)
    assert.equal(store.getSnapshot().holds.r1, true)
    store.setHold('r1', true)
    assert.equal(seen.length, 1, 'a repeated verdict does not republish')
    store.setHold('r1', false)
    assert.equal(store.getSnapshot().holds.r1, false)
    stop()
  })

  it('applies nothing when a hold frame names an unknown request', () => {
    const store = client.createStore()
    store.setHold('ghost', true)
    assert.equal(store.getSnapshot().holds.ghost, true)
    assert.deepEqual(store.getSnapshot().requests, [])
  })
})

describe('client: live countdown readings', () => {
  it('counts a fresh reading as a revision so the panel re-bases its clock', () => {
    const store = client.createStore()
    assert.deepEqual(store.getSnapshot().revisions, {})
    store.upsert({ id: 'r1', sessionId: 's1', countdown: { remainingMs: 600000, action: 'reject' } })
    assert.equal(store.getSnapshot().revisions.r1, 1)
    store.upsert({ id: 'r1', sessionId: 's1', countdown: { remainingMs: 120000, action: 'reject' } })
    assert.equal(store.getSnapshot().revisions.r1, 2)
    assert.equal(store.request('r1').countdown.remainingMs, 120000)
    store.replace([{ id: 'r2', sessionId: 's1', countdown: { remainingMs: 5000, action: 'reject' } }])
    assert.equal(store.getSnapshot().revisions.r2, 1)
    store.replace([{ id: 'r2', sessionId: 's1', countdown: { remainingMs: 3000, action: 'reject' } }])
    assert.equal(store.getSnapshot().revisions.r2, 2)
  })

  it('seeds the hold state a reconnect snapshot projects', () => {
    const store = client.createStore()
    const connection = client.createConnection({ boot: { token: 't' }, store })
    globalThis.window.__DSH_HITL__ = { token: 't', endpoint: '/dsh-hitl' }
    class FakeEventSource {
      constructor() {
        this.readyState = 1
        events.push(this)
      }

      close() { this.readyState = 2 }
    }
    const events = []
    const previous = globalThis.EventSource
    globalThis.EventSource = FakeEventSource
    try {
      connection.start()
      events[0].onmessage({
        data: JSON.stringify({
          type: 'snapshot',
          requests: [{ id: 'r1', sessionId: 's1', countdown: { remainingMs: 4000, action: 'reject', held: true } }],
        }),
      })
      assert.equal(store.getSnapshot().holds.r1, true)
      events[0].onmessage({
        data: JSON.stringify({ type: 'request', request: { id: 'r2', sessionId: 's1', countdown: { remainingMs: 9, action: 'reject', held: true } } }),
      })
      assert.equal(store.getSnapshot().holds.r2, true)
      connection.dispose()
    } finally {
      globalThis.EventSource = previous
      delete globalThis.window.__DSH_HITL__
    }
  })
})

describe('client: stream watchdog', () => {
  it('distrusts a stream that went quiet', () => {
    assert.equal(client.streamStale(0, 44000), false)
    assert.equal(client.streamStale(0, 45000), false)
    assert.equal(client.streamStale(0, 45001), true)
    assert.equal(client.streamStale(1_000_000, 1_100_000), true)
  })

  it('rebuilds a stream a reload orphaned, and keeps counting frames meanwhile', () => {
    const store = client.createStore()
    const events = []
    class FakeEventSource {
      constructor(url) {
        this.url = url
        this.readyState = 1
        events.push(this)
      }

      close() { this.readyState = 2 }
    }
    const previous = { EventSource: globalThis.EventSource, fetch: globalThis.fetch }
    globalThis.EventSource = FakeEventSource
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    try {
      const connection = client.createConnection({ boot: { token: 't' }, store })
      connection.start()
      assert.equal(events.length, 1)
      events[0].onopen()
      assert.equal(store.getSnapshot().connection, 'open')
      // Any frame — the liveness ping included — is evidence the stream is live.
      events[0].onmessage({ data: JSON.stringify({ type: 'ping', version: 1 }) })
      assert.equal(client.streamStale(Date.now(), Date.now()), false)
      connection.dispose()
      assert.equal(events[0].readyState, 2)
    } finally {
      globalThis.EventSource = previous.EventSource
      globalThis.fetch = previous.fetch
    }
  })
})

describe('client: host readings for holds', () => {
  it('adopts an acknowledged remainder as a new reading', () => {
    const store = client.createStore()
    store.upsert({ id: 'r1', sessionId: 's1', countdown: { remainingMs: 600000, action: 'reject' } })
    assert.equal(store.getSnapshot().revisions.r1, 1)
    store.applyReading('r1', 421000)
    assert.equal(store.request('r1').countdown.remainingMs, 421000)
    assert.equal(store.getSnapshot().revisions.r1, 2)
  })

  it('ignores a reading for a request it does not hold, or a non-number', () => {
    const store = client.createStore()
    store.upsert({ id: 'r1', sessionId: 's1', countdown: { remainingMs: 1000, action: 'reject' } })
    const before = store.getSnapshot()
    store.applyReading('ghost', 5000)
    store.applyReading('r1', undefined)
    store.applyReading('r1', Number.NaN)
    assert.equal(store.getSnapshot(), before, 'nothing republishes')
    assert.equal(store.request('r1').countdown.remainingMs, 1000)
  })

  it('does not fault a request without a countdown', () => {
    const store = client.createStore()
    store.upsert({ id: 'r1', sessionId: 's1', countdown: null })
    store.applyReading('r1', 5000)
    assert.equal(store.request('r1').countdown, null)
  })
})

describe('client: countdown readings are anchored at arrival', () => {
  const at = 1_700_000_000_000

  it('turns a reading into a deadline dated from when it arrived', () => {
    assert.equal(client.deadlineOf({ countdown: { remainingMs: 600000 }, observedAt: at }, at), at + 600000)
  })

  it('never pushes a deadline forward when the same reading is reused later', () => {
    // A remount fifty seconds later re-reads the same stored reading: the
    // deadline must stay put, not become "now + 600s".
    const reading = { countdown: { remainingMs: 600000 }, observedAt: at }
    assert.equal(client.deadlineOf(reading, at + 50000), at + 600000)
    assert.notEqual(client.deadlineOf(reading, at + 50000), at + 50000 + 600000)
  })

  it('falls back to now only when no arrival time is known', () => {
    assert.equal(client.deadlineOf({ countdown: { remainingMs: 1000 } }, at), at + 1000)
  })

  it('has no deadline without a countdown', () => {
    assert.equal(client.deadlineOf({ countdown: null, observedAt: at }, at), undefined)
    assert.equal(client.deadlineOf({}, at), undefined)
    assert.equal(client.deadlineOf(undefined, at), undefined)
  })

  it('stamps every stored request with its arrival time', () => {
    const store = client.createStore()
    store.upsert({ id: 'r1', sessionId: 's1', countdown: { remainingMs: 1000, action: 'reject' } })
    assert.equal(typeof store.request('r1').observedAt, 'number')
    store.replace([{ id: 'r2', sessionId: 's1', countdown: { remainingMs: 1000, action: 'reject' } }])
    assert.equal(typeof store.request('r2').observedAt, 'number')
    const before = store.request('r2').observedAt
    store.applyReading('r2', 900)
    assert.equal(store.request('r2').countdown.remainingMs, 900)
    assert.equal(store.request('r2').observedAt >= before, true, 'a host reading re-stamps arrival')
  })
})

describe('client: the pause clock', () => {
  const id = 'r1'
  const T = 1_700_000_000_000

  it('counts down when no hold is in force', () => {
    const first = client.reconcileClock({ id, at: T + 600000, frozen: undefined, hostHeld: false, now: T })
    assert.equal(first.remaining, 600000)
    const later = client.reconcileClock({ id, at: first.at, frozen: first.frozen, hostHeld: false, now: T + 5000 })
    assert.equal(later.remaining, 595000)
  })

  it('captures the remainder once when the hold starts, then holds still', () => {
    const held = client.reconcileClock({ id, at: T + 600000, frozen: undefined, hostHeld: true, now: T + 10000 })
    assert.deepEqual(held.frozen, { id, remainingMs: 590000 })
    assert.equal(held.remaining, 590000)
    // Ten seconds later the panel is still drawing the same number — the defect
    // this function exists to prevent.
    const later = client.reconcileClock({ id, at: held.at, frozen: held.frozen, hostHeld: true, now: T + 20000 })
    assert.equal(later.remaining, 590000)
    assert.deepEqual(later.frozen, { id, remainingMs: 590000 })
  })

  it('resumes from the frozen number in the same call that releases it', () => {
    const held = client.reconcileClock({ id, at: T + 600000, frozen: undefined, hostHeld: true, now: T + 10000 })
    const released = client.reconcileClock({ id, at: held.at, frozen: held.frozen, hostHeld: false, now: T + 70000 })
    assert.equal(released.frozen, undefined)
    assert.equal(released.remaining, 590000, 'the release frame draws the frozen number, not a stale deadline')
    assert.equal(released.at, T + 70000 + 590000, 'the deadline is re-based by the frozen remainder')
    const after = client.reconcileClock({ id, at: released.at, frozen: released.frozen, hostHeld: false, now: T + 70000 + 1000 })
    assert.equal(after.remaining, 589000)
  })

  it('re-derives a capture for a different request', () => {
    const held = client.reconcileClock({ id, at: T + 600000, frozen: undefined, hostHeld: true, now: T + 10000 })
    const other = client.reconcileClock({ id: 'r2', at: T + 30000, frozen: held.frozen, hostHeld: true, now: T + 10000 })
    assert.deepEqual(other.frozen, { id: 'r2', remainingMs: 20000 })
  })

  it('has no remainder without a deadline', () => {
    const idle = client.reconcileClock({ id, at: undefined, frozen: undefined, hostHeld: false, now: T })
    assert.equal(idle.remaining, undefined)
    const held = client.reconcileClock({ id, at: undefined, frozen: undefined, hostHeld: true, now: T })
    assert.equal(held.remaining, 0)
  })
})

describe('client: subagent requests reach the human', () => {
  const parent = 'session-03704d7a-b08d-466d-b84d-1a30c347057b'
  const child = '7e3ebefc-356a-4bcf-85c9-4e05464d5b7d'

  it('files a request under the asking Session alone when that is the displayed one', () => {
    assert.deepEqual(client.filingSessions({ sessionId: parent }, parent), [parent])
    assert.deepEqual(client.filingSessions({ sessionId: child }, child), [child])
  })

  it('files a delegated request a second time under the displayed Session', () => {
    assert.deepEqual(client.filingSessions({ sessionId: child }, parent), [child, parent])
  })

  it('files nothing for a request without an asking Session', () => {
    assert.deepEqual(client.filingSessions({ sessionId: undefined }, parent), [])
    assert.deepEqual(client.filingSessions(undefined, parent), [])
  })

  it('never duplicates a filing when no Session is displayed', () => {
    assert.deepEqual(client.filingSessions({ sessionId: child }, undefined), [child])
  })

  it('knows which seats answer somebody else\'s call', () => {
    assert.equal(client.isForeignRequest({ sessionId: child }, parent), true)
    assert.equal(client.isForeignRequest({ sessionId: child }, child), false)
    assert.equal(client.isForeignRequest({ sessionId: child }, undefined), false)
  })

  it('keeps the frame-level notice for requests no reachable seat shows', () => {
    const requests = [{ id: 'r1', sessionId: child }]
    const seat = { sessionId: parent, obscured: false }
    assert.equal(client.noticeVisible(requests, undefined), true)
    assert.equal(client.noticeVisible(requests, null), true)
    assert.equal(client.noticeVisible(requests, seat), false, 'a reachable panel already covers the request')
    assert.equal(client.noticeVisible(requests, { ...seat, obscured: true }), true, 'a covered panel is no surface')
    assert.equal(client.noticeVisible([], undefined), false)
    assert.equal(client.noticeVisible(undefined, undefined), false)
  })

  it('releases a seat only for the Session that claimed it', () => {
    const seat = client.createSeat()
    const seen = []
    const stop = seat.subscribe(() => { seen.push(seat.getSnapshot()) })
    const release = seat.hold(parent)
    assert.deepEqual(seat.getSnapshot(), { sessionId: parent, obscured: false })
    release()
    assert.equal(seat.getSnapshot(), undefined)
    // A stale release from a previous mount must not free the live claim: the
    // seat is what tells the notice a panel is really on screen.
    const first = seat.hold(parent)
    const second = seat.hold(child)
    first()
    assert.deepEqual(seat.getSnapshot(), { sessionId: child, obscured: false })
    second()
    assert.equal(seat.getSnapshot(), undefined)
    stop()
    assert.deepEqual(seen, [
      { sessionId: parent, obscured: false },
      undefined,
      { sessionId: parent, obscured: false },
      { sessionId: child, obscured: false },
      undefined,
    ])
  })

  it('tracks reachability per claim and keeps the snapshot stable', () => {
    const seat = client.createSeat()
    assert.equal(seat.getSnapshot(), undefined)
    // A report without a claim is ignored: an unmounted panel cannot describe a seat.
    seat.reportObscured(true)
    assert.equal(seat.getSnapshot(), undefined)
    const release = seat.hold(parent)
    const held = seat.getSnapshot()
    seat.reportObscured(false)
    assert.equal(seat.getSnapshot(), held, 'an unchanged verdict must not churn React snapshots')
    seat.reportObscured(true)
    assert.deepEqual(seat.getSnapshot(), { sessionId: parent, obscured: true })
    release()
    assert.equal(seat.getSnapshot(), undefined)
  })

  it('tracks the displayed Session in the store and re-files on a switch', () => {
    const store = client.createStore()
    assert.equal(store.getSnapshot().viewSessionId, undefined)
    let notifications = 0
    const stop = store.subscribe(() => { notifications += 1 })
    store.setView(parent)
    assert.equal(store.getSnapshot().viewSessionId, parent)
    assert.equal(notifications, 1)
    store.setView(parent)
    assert.equal(notifications, 1, 'the same Session is not a change')
    store.setView(child)
    assert.equal(store.getSnapshot().viewSessionId, child)
    store.setView(undefined)
    assert.equal(store.getSnapshot().viewSessionId, undefined)
    stop()
  })

  it('shortens a Session identity to a readable tail', () => {
    assert.equal(client.shortSession(child), '4e05464d5b7d')
    assert.equal(client.shortSession(parent), '1a30c347057b')
    assert.equal(client.shortSession('abcdef'), 'abcdef')
    assert.equal(client.shortSession(undefined), '')
    assert.equal(client.shortSession(''), '')
  })

  it('localizes the delegated-call wording in both dictionaries', () => {
    for (const dictionary of [client.zh, client.en]) {
      for (const key of ['label.foreign', 'button.gotoSession', 'aria.notice', 'notice.title', 'notice.more', 'notice.own', 'notice.subagent', 'notice.hint']) {
        assert.equal(typeof dictionary[key], 'string', `${key} is missing`)
      }
    }
    assert.equal(client.zh['label.foreign'].includes('{session}'), true)
    assert.equal(client.en['notice.title'].includes('{count}'), true)
  })
})

describe('client: the viewed-seat filing is a copy, not a second owner', () => {
  const parent = 'session-03704d7a-b08d-466d-b84d-1a30c347057b'
  const child = '7e3ebefc-356a-4bcf-85c9-4e05464d5b7d'
  const makePrimary = () => {
    const sent = []
    const connection = { decide: (id, decision) => { sent.push([id, decision]); return Promise.resolve({ ok: true }) } }
    const request = { id: 'req-1', sessionId: child, toolName: 'glob' }
    return { primary: new client.PendingHitl(request, connection, 3), sent, request }
  }

  it('files the copy under the viewed Session with its own key', () => {
    const { primary } = makePrimary()
    const view = new client.PendingHitlView(primary, parent)
    assert.equal(view.key, 'req-1@view')
    assert.equal(view.sessionId, parent)
    assert.equal(view.request, primary.request)
    assert.equal(view.sequence, 3, 'the copy keeps the request age, so precedence still ranks requests')
    assert.equal(view.kind, 'hitl')
  })

  it('sends a decision from either seat for the one call', () => {
    const { primary, sent, request } = makePrimary()
    const view = new client.PendingHitlView(primary, parent)
    view.answer({ kind: 'approve' })
    primary.answer({ kind: 'reject' })
    assert.deepEqual(sent, [[request.id, { kind: 'approve' }], [request.id, { kind: 'reject' }]])
  })

  it('never delegates the request when only the copy is released', () => {
    const { primary } = makePrimary()
    const view = new client.PendingHitlView(primary, parent)
    view.delegate()
    assert.equal(primary.answerable, true, 'releasing the copy must leave the asking Session its own seat')
    assert.equal(view.answerable, true)
    primary.delegate()
    assert.equal(primary.answerable, false)
    assert.equal(view.answerable, false, 'the copy follows the owner it copies')
  })
})

describe('client: the field header never promises more than the control', () => {
  const markdown = { param: 'pattern', render: 'markdown', editable: true }
  const text = { param: 'path', render: 'text', editable: true }
  const readOnly = { param: 'target', render: 'markdown', editable: false }
  const diff = { param: 'change', render: 'diff', editable: true }

  it('claims editable only while the field really takes input', () => {
    assert.equal(client.claimsEditable(text, true), true)
    assert.equal(client.claimsEditable(markdown, true), true)
  })

  it('drops the claim while the panel is submitting, settled, or expired', () => {
    // A text field renders as a read-only block in exactly these states, so the
    // header must stop saying "editable" the moment the panel stops taking one.
    assert.equal(client.claimsEditable(text, false), false)
    assert.equal(client.claimsEditable(markdown, false), false)
  })

  it('never claims editable for a field without an editor', () => {
    assert.equal(client.claimsEditable(readOnly, true), false)
    assert.equal(client.claimsEditable(diff, true), false)
    assert.equal(client.claimsEditable(undefined, true), false)
  })
})

describe('client: a timeout stays readable instead of vanishing', () => {
  const request = { id: 'req-1', sessionId: 'session-a', toolName: 'glob' }

  it('keeps a closed request on screen and marks why it closed', () => {
    const store = client.createStore()
    store.upsert(request)
    store.finish('req-1', 'timeout')
    assert.equal(store.getSnapshot().requests.length, 1, 'the panel still has something to draw')
    assert.equal(store.getSnapshot().outcomes['req-1'], 'timeout')
    assert.equal(store.getSnapshot().settled['req-1'], 'timeout')
    store.remove('req-1')
    assert.deepEqual(store.getSnapshot().requests, [])
    assert.equal(store.getSnapshot().outcomes['req-1'], undefined, 'removal clears the closed mark')
  })

  it('drops an ordinary settle at once and clears any closed mark', () => {
    const store = client.createStore()
    store.upsert(request)
    store.finish('req-1', 'timeout')
    store.settle('req-1', 'user')
    assert.deepEqual(store.getSnapshot().requests, [])
    assert.equal(store.getSnapshot().outcomes['req-1'], undefined)
    assert.equal(store.getSnapshot().settled['req-1'], 'user')
  })

  it('ignores a close for a request it never had', () => {
    const store = client.createStore()
    let notifications = 0
    const stop = store.subscribe(() => { notifications += 1 })
    store.finish('missing', 'timeout')
    assert.equal(notifications, 0)
    stop()
  })
})

describe('client: the frame-level notice fails silently', () => {
  it('localizes an empty state instead of an empty box', () => {
    // The notice wraps itself in the panel's error boundary with a `null`
    // fallback: a surface that renders over the whole frame must be able to
    // disappear, not draw an empty panel where the app used to be.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
      .slice(readFileSync(new URL('../client.js', import.meta.url), 'utf8').indexOf('class PanelBoundary'))
    assert.equal(source.includes('if (this.props.fallback === null) return null'), true)
    assert.equal(source.includes('fallback: null'), true, 'the notice must ask for silence')
  })
})

describe('client: reachability of a seated panel', () => {
  const withDom = (elementFromPoint, size = { width: 400, height: 200 }) => {
    const previousDocument = globalThis.document
    const previousWindow = globalThis.window
    globalThis.window = { innerWidth: 1200, innerHeight: 800, __ModuleLoader__: globalThis.window?.__ModuleLoader__ }
    globalThis.document = { elementFromPoint }
    const element = {
      getBoundingClientRect: () => ({ left: 400, top: 500, width: size.width, height: size.height }),
      contains: candidate => candidate === 'inside' || candidate === element,
    }
    return {
      element,
      restore() {
        globalThis.document = previousDocument
        globalThis.window = previousWindow
      },
    }
  }

  it('reports reachable when hit testing lands inside the panel', () => {
    const dom = withDom(() => 'inside')
    try {
      assert.equal(client.isObscured(dom.element), false)
    } finally {
      dom.restore()
    }
  })

  it('reports obscured when a mask, a dialog, or anything else is on top', () => {
    const dom = withDom(() => 'mask')
    try {
      assert.equal(client.isObscured(dom.element), true)
    } finally {
      dom.restore()
    }
  })

  it('reports obscured when nothing is hit-testable at the sample point', () => {
    const dom = withDom(() => null)
    try {
      assert.equal(client.isObscured(dom.element), true)
    } finally {
      dom.restore()
    }
  })

  it('reports obscured for a collapsed or absent panel', () => {
    const dom = withDom(() => 'inside', { width: 0, height: 0 })
    try {
      assert.equal(client.isObscured(dom.element), true)
      assert.equal(client.isObscured(undefined), true)
      assert.equal(client.isObscured(null), true)
    } finally {
      dom.restore()
    }
  })

  it('stays silent where the DOM cannot answer', () => {
    const previousDocument = globalThis.document
    globalThis.document = undefined
    try {
      const element = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }), contains: () => true }
      assert.equal(client.isObscured(element), false, 'without a DOM the seat keeps its claim')
    } finally {
      globalThis.document = previousDocument
    }
  })
})
