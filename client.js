/**
 * dsh-hitl browser half: the decision panel.
 *
 * One self-contained classic script, because a profile-installed `dsh.client`
 * bundle is served verbatim and cannot be bundled: React comes from the browser
 * module table, everything else — the markdown renderer, the split diff, the
 * countdown, the markup and the CSS — is written here against the host's theme
 * tokens. Harness client packages are deliberately not imported.
 *
 * Data flow: the downlink is a Server-Sent-Events stream on this plugin's own
 * route, the uplink is one JSON POST per decision. A pending request becomes a
 * session-scoped pending interaction (`ctx.uiSession.registerPendingInteraction`)
 * so the shipped composer chain seats the panel exactly where the shipped
 * approval and question panels sit.
 */

window.__ModuleLoader__.load({
  id: 'dsh-hitl',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'hitl'
    /** Discriminator of the pending-interaction values this half publishes. */
    const KIND = 'hitl'
    /** Pending-interaction precedence: a blocked tool call outranks approval and question panels. */
    const PRECEDENCE = 1000000
    /** Composer-chain priority: the shipped entries use 0 and 1, so a decision outranks them. */
    const CHAIN_PRIORITY = 5
    /** Largest line count either diff side may have before the panel stops aligning. */
    const DIFF_LINE_LIMIT = 2000
    /** How long the panel waits for the host's settled frame before closing itself. */
    const SETTLE_GRACE_MS = 8000
    /** How long the frame-level notice waits before claiming a composer seat is really absent. */
    const NOTICE_DELAY_MS = 600
    /** How long a decision the human did not make stays on screen, saying what happened. */
    const LINGER_MS = 5000
    /** Outcomes worth reading: a timeout is the one the human never chose. */
    const LINGER_OUTCOMES = ['timeout']
    /** How often a seated panel re-tests whether the human can still reach it. */
    const OBSCURE_POLL_MS = 1000
    /** How far below a seated panel's top edge the reachability probe samples. */
    const OBSCURE_SAMPLE_INSET_PX = 40

    const zh = {
      'title.default': '请确认 {tool} 的执行方案',
      'label.countdown': '剩余 {seconds}s',
      'label.countdownHeld': '已暂停（交互中）· 剩余 {seconds}s',
      'label.timeout': '已超时，等待宿主处理',
      'label.offline': '决策通道未连接，正在重试',
      'label.offlineNoToken': '当前页面未注入 HITL 通道，无法决策',
      'label.queued': '另有 {count} 项待决策',
      'label.editable': '可编辑',
      'label.readonly': '只读',
      'label.truncated': '内容已截断',
      'label.diffChanged': '变更 {path}',
      'label.diffPlain': '变更内容',
      'label.empty': '（空）',
      'button.approve': '同意',
      'button.modify': '修改',
      'button.reject': '拒绝',
      'button.rejecting': '拒绝…',
      'button.submitting': '提交中…',
      'button.retry': '重试',
      'feedback.placeholder': '可补充拒绝原因，它会随拒绝一起交给 Agent',
      'feedback.required': '请填写拒绝原因',
      'feedback.title': '拒绝原因（可选）',
      'modify.note': '你将把修改后的内容交给 Agent：本次调用不会执行。',
      'markdown.edit': '编辑',
      'markdown.preview': '预览',
      'markdown.split': '并排',
      'markdown.empty': '（空文档）',
      'error.submit': '提交失败：{message}',
      'error.diffTooLarge': '内容过大，已改为原文对照',
      'settled.byUser': '已提交',
      'settled.byTimeout': '已按超时策略处理',
      'settled.byHost': '请求已撤回',
      'aria.dialog': '{tool} 的人工决策',
      'aria.field': '{title} 的提案内容',
      'aria.collapse': '收起待决策提案',
      'aria.expand': '展开待决策提案',
      'button.collapse': '收起',
      'button.expand': '展开',
      'label.foreign': '来自子代理会话 {session}',
      'button.gotoSession': '前往该会话',
      'aria.notice': '等待人工决策的工具调用',
      'notice.title': '{count} 条工具调用等待人工决策',
      'notice.more': '另有 {count} 条',
      'notice.own': '本会话',
      'notice.subagent': '子代理会话 {session}',
      'notice.hint': '完整面板（修改、带原因的拒绝）在该会话的输入框上',
    }

    const en = {
      'title.default': 'Confirm how {tool} runs',
      'label.countdown': '{seconds}s left',
      'label.countdownHeld': 'paused while you edit · {seconds}s left',
      'label.timeout': 'timed out; the host is settling it',
      'label.offline': 'decision channel offline, retrying',
      'label.offlineNoToken': 'this page carries no HITL channel, so no decision can be sent',
      'label.queued': '{count} more waiting',
      'label.editable': 'editable',
      'label.readonly': 'read-only',
      'label.truncated': 'truncated',
      'label.diffChanged': 'change {path}',
      'label.diffPlain': 'change',
      'label.empty': '(empty)',
      'button.approve': 'Approve',
      'button.modify': 'Modify',
      'button.reject': 'Reject',
      'button.rejecting': 'Reject…',
      'button.submitting': 'Sending…',
      'button.retry': 'Retry',
      'feedback.placeholder': 'Optional reason; it reaches the agent with your rejection',
      'feedback.required': 'A reason is required',
      'feedback.title': 'Rejection reason (optional)',
      'modify.note': 'Your edited text goes to the agent: this call will not run.',
      'markdown.edit': 'Edit',
      'markdown.preview': 'Preview',
      'markdown.split': 'Side by side',
      'markdown.empty': '(empty document)',
      'error.submit': 'could not submit: {message}',
      'error.diffTooLarge': 'too large to align; showing both sides',
      'settled.byUser': 'submitted',
      'settled.byTimeout': 'settled by the timeout policy',
      'settled.byHost': 'withdrawn',
      'aria.dialog': 'human decision for {tool}',
      'aria.field': 'proposal for {title}',
      'aria.collapse': 'Hide the proposal',
      'aria.expand': 'Show the proposal',
      'button.collapse': 'Hide',
      'button.expand': 'Show',
      'label.foreign': 'from subagent Session {session}',
      'button.gotoSession': 'Open that Session',
      'aria.notice': 'Tool calls waiting for a human decision',
      'notice.title': '{count} tool calls waiting for a human decision',
      'notice.more': '{count} more',
      'notice.own': 'this Session',
      'notice.subagent': 'subagent Session {session}',
      'notice.hint': 'The full panel (modify, reject with a reason) is on that Session\u2019s composer.',
    }

    // ── pure helpers ─────────────────────────────────────────────────────────

    /** Escape one text run for HTML output; every tag the renderer emits is its own. */
    function escapeHtml(text) {
      return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
    }

    /** Whether a link target is safe to render as an anchor. */
    function safeHref(target) {
      const trimmed = String(target).trim()
      if (trimmed === '') return undefined
      if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed
      return undefined
    }

    /** Render one escaped text run with inline markdown (code, bold, italic, links). */
    function renderInline(escaped) {
      let out = escaped
      out = out.replace(/`([^`]+)`/g, (_match, code) => `<code class="dsh-hitl-code">${code}</code>`)
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, target) => {
        const href = safeHref(target.replaceAll('&amp;', '&'))
        if (href === undefined) return match
        const safe = href.replaceAll('"', '%22').replaceAll('<', '%3C').replaceAll('>', '%3E')
        return `<a class="dsh-hitl-link" href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`
      })
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      return out
    }

    /**
     * Render a small, safe markdown subset to HTML: fenced code, headings,
     * blockquotes, lists, rules, paragraphs, and the inline forms above.
     * Escaping happens before any tag is emitted, so raw HTML in the source
     * can never become markup.
     * @param text - the markdown source.
     * @returns an HTML string built only from this function's own tags.
     */
    function renderMarkdownHtml(text) {
      const lines = String(text).replaceAll('\r\n', '\n').split('\n')
      const out = []
      let index = 0
      let list = null
      const closeList = () => {
        if (list !== null) {
          out.push(`</${list}>`)
          list = null
        }
      }
      while (index < lines.length) {
        const line = lines[index]
        const fence = /^\s*```(.*)$/.exec(line)
        if (fence !== null) {
          closeList()
          const language = escapeHtml(fence[1].trim())
          index += 1
          const body = []
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          out.push(`<pre class="dsh-hitl-pre"${language === '' ? '' : ` data-lang="${language}"`}><code>${escapeHtml(body.join('\n'))}</code></pre>`)
          continue
        }
        if (/^\s*$/.test(line)) {
          closeList()
          index += 1
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          closeList()
          const level = heading[1].length + 2
          out.push(`<h${level} class="dsh-hitl-h">${renderInline(escapeHtml(heading[2]))}</h${level}>`)
          index += 1
          continue
        }
        if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
          closeList()
          out.push('<hr class="dsh-hitl-hr"/>')
          index += 1
          continue
        }
        const quote = /^\s*>\s?(.*)$/.exec(line)
        if (quote !== null) {
          closeList()
          const body = [quote[1]]
          index += 1
          while (index < lines.length) {
            const next = /^\s*>\s?(.*)$/.exec(lines[index])
            if (next === null) break
            body.push(next[1])
            index += 1
          }
          out.push(`<blockquote class="dsh-hitl-quote">${renderInline(escapeHtml(body.join('\n')))}</blockquote>`)
          continue
        }
        const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (unordered !== null || ordered !== null) {
          const kind = unordered === null ? 'ol' : 'ul'
          if (list !== kind) {
            closeList()
            list = kind
            out.push(`<${kind} class="dsh-hitl-list">`)
          }
          out.push(`<li>${renderInline(escapeHtml((unordered ?? ordered)[1]))}</li>`)
          index += 1
          continue
        }
        closeList()
        const paragraph = [line]
        index += 1
        while (index < lines.length
          && !/^\s*$/.test(lines[index])
          && !/^\s*```/.test(lines[index])
          && !/^#{1,6}\s/.test(lines[index])
          && !/^\s*[-*+]\s+/.test(lines[index])
          && !/^\s*\d+[.)]\s+/.test(lines[index])
          && !/^\s*>/.test(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        out.push(`<p class="dsh-hitl-p">${renderInline(escapeHtml(paragraph.join('\n'))).replaceAll('\n', '<br/>')}</p>`)
      }
      closeList()
      return out.join('')
    }

    /** Split one diff side into lines; empty text is no lines, not one empty line. */
    function splitDiffSide(text) {
      const value = String(text ?? '').replaceAll('\r\n', '\n')
      return value === '' ? [] : value.split('\n')
    }

    /** Longest common subsequence trace of two line arrays, guarded by a size cap. */
    function diffLines(oldText, newText) {
      const before = splitDiffSide(oldText)
      const after = splitDiffSide(newText)
      if (before.length > DIFF_LINE_LIMIT || after.length > DIFF_LINE_LIMIT) return undefined
      const rows = new Map()
      const columns = after.length + 1
      for (let i = 0; i <= before.length; i += 1) {
        for (let j = 0; j <= after.length; j += 1) {
          if (i === 0 || j === 0) rows.set(i * columns + j, 0)
          else if (before[i - 1] === after[j - 1]) rows.set(i * columns + j, (rows.get((i - 1) * columns + (j - 1)) ?? 0) + 1)
          else rows.set(i * columns + j, Math.max(rows.get((i - 1) * columns + j) ?? 0, rows.get(i * columns + (j - 1)) ?? 0))
        }
      }
      const pairs = []
      let i = before.length
      let j = after.length
      while (i > 0 && j > 0) {
        if (before[i - 1] === after[j - 1]) {
          pairs.push({ type: 'same', left: { number: i, text: before[i - 1] }, right: { number: j, text: after[j - 1] } })
          i -= 1
          j -= 1
          continue
        }
        const up = rows.get((i - 1) * columns + j) ?? 0
        const left = rows.get(i * columns + (j - 1)) ?? 0
        if (left >= up) {
          pairs.push({ type: 'added', left: null, right: { number: j, text: after[j - 1] } })
          j -= 1
        } else {
          pairs.push({ type: 'removed', left: { number: i, text: before[i - 1] }, right: null })
          i -= 1
        }
      }
      while (i > 0) {
        pairs.push({ type: 'removed', left: { number: i, text: before[i - 1] }, right: null })
        i -= 1
      }
      while (j > 0) {
        pairs.push({ type: 'added', left: null, right: { number: j, text: after[j - 1] } })
        j -= 1
      }
      pairs.reverse()
      let added = 0
      let removed = 0
      for (const row of pairs) {
        if (row.type === 'added') added += 1
        if (row.type === 'removed') removed += 1
      }
      return { rows: pairs, added, removed }
    }

    /** Second-granularity countdown label text. */
    function formatRemaining(milliseconds) {
      const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
      return String(seconds)
    }

    /**
     * Which primary button the panel shows: an edited proposal turns Approve into Modify.
     * @param edited - whether any editable field differs from its original value.
     * @param request - the wire request.
     * @param t - translator.
     * @returns the primary button's label.
     */
    function primaryLabel(edited, request, t) {
      const buttons = request.buttons ?? {}
      if (edited) return buttons.modify ?? t('button.modify')
      return buttons.approve ?? t('button.approve')
    }

    /** The changed editable fields of one proposal, as the modify decision carries them. */
    function changedFields(fields, drafts) {
      const changed = []
      for (const field of fields) {
        if (field.editable !== true) continue
        const next = drafts[field.param]
        if (typeof next !== 'string') continue
        if (next === field.value) continue
        changed.push({ param: field.param, text: next })
      }
      return changed
    }

    /** Seconds at which a countdown starts reading as urgent. */
    const COUNTDOWN_WARN_SECONDS = 10

    /**
     * How loudly one countdown should read. A decision panel is a blocking
     * interruption, so the remaining time must be visible at a glance rather
     * than inferred from faint grey text.
     * @param remainingMs - milliseconds left, or undefined without a countdown.
     * @param held - whether the client froze the countdown for input.
     * @param timedOut - whether the deadline already passed.
     * @returns `timeout`, `held`, `warn`, or `normal`.
     */
    function countdownTone(remainingMs, held, timedOut) {
      if (timedOut === true) return 'timeout'
      if (held === true) return 'held'
      if (typeof remainingMs === 'number' && remainingMs <= COUNTDOWN_WARN_SECONDS * 1000) return 'warn'
      return 'normal'
    }

    /** How long a quiet stream may stay open before the client rebuilds it. */
    const STREAM_SILENCE_MS = 45000

    /**
     * Whether an open stream went quiet for long enough to distrust it. A plugin
     * reload or a sleeping laptop can leave a socket open that no longer carries
     * anything, and an EventSource never notices by itself.
     * @param lastFrameAt - when the last frame arrived.
     * @param now - the current clock reading.
     * @returns whether the stream should be rebuilt.
     */
    function streamStale(lastFrameAt, now) {
      return now - lastFrameAt > STREAM_SILENCE_MS
    }

    /**
     * The absolute deadline one host reading implies.
     *
     * A reading means "this much was left *when this page received it*", not
     * "this much is left from now": anchoring it at the arrival time keeps a
     * remount, a re-delivered frame, or a re-render from pushing the deadline
     * forward, and it makes the panel independent of any clock skew between the
     * host and the browser (only a duration is trusted, never a timestamp).
     * @param reading - a request carrying `countdown.remainingMs` and `observedAt`.
     * @param now - the current clock reading, used when no arrival time is known.
     * @returns the deadline in client-clock milliseconds, or undefined without a countdown.
     */
    function deadlineOf(reading, now) {
      const remainingMs = reading?.countdown?.remainingMs
      if (typeof remainingMs !== 'number') return undefined
      const observedAt = typeof reading.observedAt === 'number' ? reading.observedAt : now
      return observedAt + remainingMs
    }

    /**
     * Fold one render's clock inputs into the clock the panel draws.
     *
     * Three rules live here, and each one fixed a real defect:
     *
     * 1. A hold start captures the remainder once; while the hold lasts the
     *    number stays put, so a paused panel cannot keep counting down.
     * 2. A hold release re-bases the deadline in the same call that stops
     *    showing the frozen number, so the release frame never draws the raw —
     *    already past — deadline.
     * 3. With no hold, the remainder is derived from the deadline every render,
     *    which is what makes the countdown tick.
     *
     * @param input - the stored deadline, the stored frozen value, the host's hold verdict, and the clock.
     * @returns the deadline, frozen value, and remainder to store and draw.
     */
    function reconcileClock({ id, at, frozen, hostHeld, now }) {
      let deadlineAt = at
      let hold = frozen
      if (hostHeld) {
        if (hold === undefined || hold.id !== id) {
          hold = { id, remainingMs: deadlineAt === undefined ? 0 : Math.max(0, deadlineAt - now) }
        }
      } else if (hold !== undefined && hold.id === id) {
        if (deadlineAt !== undefined) deadlineAt = now + hold.remainingMs
        hold = undefined
      }
      const remaining = hold !== undefined
        ? hold.remainingMs
        : (deadlineAt === undefined ? undefined : deadlineAt - now)
      return { at: deadlineAt, frozen: hold, remaining }
    }

    /** Short display form of a Session identity: its last dash-separated group. */
    function shortSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      const tail = sessionId.includes('-') ? sessionId.slice(sessionId.lastIndexOf('-') + 1) : sessionId
      return tail.length >= 6 ? tail : sessionId.slice(-6)
    }

    /**
     * Where one request must be filed so the human meets it where they look.
     *
     * A request always belongs to the Session whose tool call was gated. That
     * is the whole story while that Session is on screen — but a subagent's
     * call belongs to a child Session nobody is looking at, and a pending
     * interaction is only ever elected for the *displayed* Session. Filing a
     * second copy under the displayed Session is what keeps a delegated call
     * from waiting in a room no human ever walks into.
     *
     * @param request - the pending request.
     * @param viewSessionId - the Session the composer chain is currently rendering.
     * @returns the Session identities to file under, the asking one first.
     */
    function filingSessions(request, viewSessionId) {
      const own = request?.sessionId
      if (typeof own !== 'string' || own === '') return []
      if (typeof viewSessionId !== 'string' || viewSessionId === '' || viewSessionId === own) return [own]
      return [own, viewSessionId]
    }

    /** Whether a seat filed under `filedUnder` is answering some other Session's call. */
    function isForeignRequest(request, filedUnder) {
      const own = request?.sessionId
      return typeof own === 'string' && own !== '' && typeof filedUnder === 'string' && filedUnder !== own
    }

    /**
     * Whether the frame-level notice must speak for requests no composer seat shows.
     *
     * The seat is held exactly while a HITL panel is mounted in the composer, and
     * a mounted panel already covers every live request of the displayed Session
     * (it queues them) — but only while the human can actually see it. A
     * full-viewport modal (the settings dialog is one) covers the composer
     * without unmounting it, and a panel nobody can reach is no surface at all.
     * Anything else — no Session selected, another main panel on screen, or a
     * higher-precedence shipped panel holding the composer — already leaves the
     * seat unclaimed.
     *
     * @param requests - every live request known to this page.
     * @param seat - the seat snapshot: the claimed Session plus whether it is obscured, if any.
     * @returns whether the notice must render.
     */
    function noticeVisible(requests, seat) {
      if (!Array.isArray(requests) || requests.length === 0) return false
      if (seat === undefined || seat === null) return true
      return seat.obscured === true
    }

    /**
     * Whether a mounted element is hidden from the human despite being on screen.
     *
     * Hit testing answers the question the seat actually asks: "can this request
     * be decided where it is drawn?" A covering modal mask, a clipped ancestor,
     * or a panel scrolled out of the viewport all return the same verdict, and
     * none of them is visible in layout numbers alone.
     *
     * @param element - the mounted surface to test.
     * @returns whether something else is on top of it, or it cannot be reached at all.
     */
    function isObscured(element) {
      if (element === undefined || element === null || typeof element.getBoundingClientRect !== 'function') return true
      const doc = typeof document === 'undefined' ? undefined : document
      if (doc === undefined || typeof doc.elementFromPoint !== 'function') return false
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return true
      const x = rect.left + rect.width / 2
      const y = rect.top + Math.min(rect.height / 2, OBSCURE_SAMPLE_INSET_PX)
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true
      const top = doc.elementFromPoint(x, y)
      return top === null || top === undefined || !element.contains(top)
    }

    /**
     * The composer-seat registry: which Session's composer currently shows a panel,
     * and whether that panel is still reachable.
     *
     * The panel claims the seat on mount and releases it on unmount; while it is
     * mounted it reports what hit testing says about its own visibility. The
     * frame-level notice reads both, so "a human is looking at this request"
     * is a measured fact rather than an assumption about Session state.
     * @returns the observable seat with its claim, release, and visibility report.
     */
    function createSeat() {
      let state
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      const publish = next => {
        if (state === next) return
        state = next
        emit()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /** Stable snapshot: a new object only when a field really changed. */
        getSnapshot: () => state,
        /** Claim the seat for one Session; the returned release only frees its own claim. */
        hold(id) {
          publish({ sessionId: id, obscured: false })
          return () => {
            if (state === undefined || state.sessionId !== id) return
            publish(undefined)
          }
        },
        /** Record whether the claimed panel is still reachable; ignored without a claim. */
        reportObscured(obscured) {
          if (state === undefined) return
          const next = obscured === true
          // A repeated verdict is not a change: React reads this snapshot every
          // render, and a fresh object would re-render the whole frame each poll.
          if (state.obscured === next) return
          publish({ sessionId: state.sessionId, obscured: next })
        },
      }
    }

    /** Collapse preference shared by every request in one page session. */
    const collapsePreference = { collapsed: false }

    // ── store ────────────────────────────────────────────────────────────────

    /** Observable snapshot for the panel: connection state, holds, and pending requests. */
    function createStore() {
      let state = {
        connection: 'connecting',
        requests: [],
        settled: {},
        holds: {},
        revisions: {},
        outcomes: {},
        viewSessionId: undefined,
      }
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => state,
        setConnection(connection) {
          if (state.connection === connection) return
          state = { ...state, connection }
          emit()
        },
        /**
         * Record which Session the composer chain is rendering.
         *
         * Every filing decision reads this, so switching Sessions re-files the
         * open requests onto the Session that just became visible.
         */
        setView(viewSessionId) {
          if (state.viewSessionId === viewSessionId) return
          state = { ...state, viewSessionId }
          emit()
        },
        upsert(request) {
          const stamped = { ...request, observedAt: Date.now() }
          const requests = [...state.requests.filter(entry => entry.id !== request.id), stamped]
          const revisions = { ...state.revisions, [request.id]: (state.revisions?.[request.id] ?? 0) + 1 }
          state = { ...state, requests, revisions }
          emit()
        },
        replace(requests) {
          const receivedAt = Date.now()
          const stamped = requests.map(request => ({ ...request, observedAt: receivedAt }))
          const revisions = { ...state.revisions }
          for (const request of stamped) revisions[request.id] = (revisions[request.id] ?? 0) + 1
          state = { ...state, requests: stamped, revisions }
          emit()
        },
        settle(id, outcome) {
          const settled = { ...state.settled, [id]: outcome }
          const outcomes = { ...state.outcomes }
          delete outcomes[id]
          state = { ...state, requests: state.requests.filter(entry => entry.id !== id), settled, outcomes }
          emit()
        },
        /**
         * Mark one request closed but keep it on screen, so a decision the human
         * did not make can still be read instead of vanishing mid-sentence. The
         * caller removes it when the reading time is over.
         */
        finish(id, outcome) {
          if (!state.requests.some(entry => entry.id === id)) return
          state = {
            ...state,
            settled: { ...state.settled, [id]: outcome },
            outcomes: { ...state.outcomes, [id]: outcome },
          }
          emit()
        },
        remove(id) {
          const outcomes = { ...state.outcomes }
          delete outcomes[id]
          state = { ...state, requests: state.requests.filter(entry => entry.id !== id), outcomes }
          emit()
        },
        /**
         * Adopt one host-computed remainder as the newest reading of a request:
         * the panel re-bases its clock from it exactly as it would from a fresh
         * request frame. Used by an interaction-hold acknowledgement, where the
         * host's number is the only one that agrees with the host's deadline.
         */
        applyReading(id, remainingMs) {
          if (!Number.isFinite(remainingMs)) return
          let found = false
          const receivedAt = Date.now()
          const requests = state.requests.map((request) => {
            if (request.id !== id || request.countdown === null || request.countdown === undefined) return request
            found = true
            return { ...request, observedAt: receivedAt, countdown: { ...request.countdown, remainingMs } }
          })
          if (!found) return
          const revisions = { ...state.revisions, [id]: (state.revisions?.[id] ?? 0) + 1 }
          state = { ...state, requests, revisions }
          emit()
        },

        /**
         * Record the host's verdict on one interaction hold. The panel trusts
         * this and nothing else: a local focus flag must never claim a pause the
         * host did not grant.
         */
        setHold(id, held) {
          if ((state.holds?.[id] === true) === held) return
          state = { ...state, holds: { ...state.holds, [id]: held } }
          emit()
        },
        request(id) {
          return state.requests.find(entry => entry.id === id)
        },
      }
    }

    // ── connection ───────────────────────────────────────────────────────────

    /** How often an un-injected page re-reads its boot facts before giving up for that load. */
    const BOOT_RETRY_MS = 5000

    /**
     * The plugin's own transport: an SSE downlink and one POST uplink.
     *
     * Boot facts are re-read from the page global on every attempt, and an
     * attempt is retried while they are missing: a page that was already open
     * when this bundle was first installed only receives them on its next load,
     * so the client must not treat their absence as a permanent state.
     * @param input - the boot facts observed at activation and the store to publish into.
     * @returns the connection handle the panel calls.
     */
    function createConnection({ boot, store }) {
      let source
      let retry
      let watchdog
      let lastFrameAt = Date.now()
      let disposed = false
      const linger = new Map()

      const facts = () => {
        const candidate = typeof globalThis === 'undefined' ? undefined : globalThis.__DSH_HITL__
        return candidate === null || candidate === undefined ? boot : candidate
      }
      const endpoint = value => typeof value?.endpoint === 'string' && value.endpoint !== '' ? value.endpoint : '/dsh-hitl'
      const tokenOf = value => typeof value?.token === 'string' && value.token !== '' ? value.token : undefined

      const handle = frame => {
        if (frame === null || typeof frame !== 'object') return
        lastFrameAt = Date.now()
        if (frame.type === 'snapshot' && Array.isArray(frame.requests)) {
          store.replace(frame.requests)
          for (const request of frame.requests) {
            if (request.countdown?.held === true) store.setHold(request.id, true)
          }
          return
        }
        if (frame.type === 'request' && frame.request !== undefined) {
          store.upsert(frame.request)
          if (frame.request.countdown?.held === true) store.setHold(frame.request.id, true)
          return
        }
        if (frame.type === 'settled' && typeof frame.id === 'string') {
          const outcome = frame.outcome ?? 'user'
          // A timeout is the one outcome nobody chose: it keeps the panel on
          // screen for a beat, saying what the host did, instead of vanishing the
          // instant the countdown hits zero.
          if (LINGER_OUTCOMES.includes(outcome)) {
            store.finish(frame.id, outcome)
            scheduleLinger(frame.id)
            return
          }
          store.settle(frame.id, outcome)
          return
        }
        if (frame.type === 'holdAck' && typeof frame.id === 'string') {
          store.setHold(frame.id, frame.held === true)
          store.applyReading(frame.id, frame.remainingMs)
        }
      }

      function scheduleRetry() {
        if (disposed || retry !== undefined) return
        retry = setTimeout(() => {
          retry = undefined
          connect()
        }, BOOT_RETRY_MS)
        if (typeof retry?.unref === 'function') retry.unref()
      }

      /** Keep one closed request on screen for its reading time, then drop it. */
      function scheduleLinger(id) {
        const existing = linger.get(id)
        if (existing !== undefined) clearTimeout(existing)
        const timer = setTimeout(() => {
          linger.delete(id)
          store.remove(id)
        }, LINGER_MS)
        if (typeof timer?.unref === 'function') timer.unref()
        linger.set(id, timer)
      }

      function connect() {
        if (disposed) return
        const current = facts()
        const token = tokenOf(current)
        if (token === undefined || typeof EventSource !== 'function') {
          store.setConnection('unavailable')
          scheduleRetry()
          return
        }
        if (source !== undefined) return
        try {
          source = new EventSource(`${endpoint(current)}/events?token=${encodeURIComponent(token)}`)
        } catch {
          store.setConnection('unavailable')
          scheduleRetry()
          return
        }
        lastFrameAt = Date.now()
        source.onopen = () => {
          lastFrameAt = Date.now()
          store.setConnection('open')
        }
        watchdog = setInterval(() => {
          if (source === undefined || !streamStale(lastFrameAt, Date.now())) return
          try {
            source.close()
          } catch {
            /* already closed */
          }
          source = undefined
          store.setConnection('connecting')
          scheduleRetry()
        }, 15000)
        if (typeof watchdog?.unref === 'function') watchdog.unref()
        source.onerror = () => {
          // A closed stream never reconnects on its own (a refused token, or a
          // restarted host), so this half rebuilds it from freshly read facts.
          if (source !== undefined && source.readyState === 2) {
            store.setConnection('unavailable')
            if (watchdog !== undefined) {
              clearInterval(watchdog)
              watchdog = undefined
            }
            try {
              source.close()
            } catch {
              /* already closed */
            }
            source = undefined
            scheduleRetry()
            return
          }
          store.setConnection('connecting')
        }
        source.onmessage = event => {
          try {
            handle(JSON.parse(event.data))
          } catch {
            /* a malformed frame is dropped; the next snapshot resynchronizes */
          }
        }
      }

      async function post(body) {
        const current = facts()
        const token = tokenOf(current)
        if (token === undefined) throw new Error('the HITL decision channel is unavailable in this page')
        const response = await fetch(`${endpoint(current)}/decide`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        })
        let payload
        try {
          payload = await response.json()
        } catch {
          payload = undefined
        }
        if (!response.ok || payload?.ok !== true) {
          const reason = payload?.message ?? `HTTP ${response.status}`
          throw new Error(reason)
        }
        return payload
      }

      return {
        start: connect,
        dispose() {
          disposed = true
          if (retry !== undefined) {
            clearTimeout(retry)
            retry = undefined
          }
          if (watchdog !== undefined) {
            clearInterval(watchdog)
            watchdog = undefined
          }
          for (const timer of linger.values()) clearTimeout(timer)
          linger.clear()
          try {
            source?.close()
          } catch {
            /* already closed */
          }
        },
        decide(id, decision) {
          return post({ type: 'decide', id, decision })
        },
        hold(id, held) {
          return post({ type: 'hold', id, held }).catch(() => undefined)
        },
      }
    }

    // ── pending interaction ──────────────────────────────────────────────────

    /** One request as the composer-chain selector and the panel see it. */
    class PendingHitl {
      constructor(request, connection, sequence) {
        this.kind = KIND
        this.key = request.id
        this.sessionId = request.sessionId
        this.request = request
        this.sequence = sequence
        this.connection = connection
        this.delegated = false
      }

      /** Whether the panel may still send a decision. */
      get answerable() {
        return !this.delegated
      }

      /** Send one decision for this request. */
      answer(decision) {
        return this.connection.decide(this.request.id, decision)
      }

      /** The seat was released: stop offering the panel; the host keeps its own deadline. */
      delegate() {
        this.delegated = true
        return Promise.resolve()
      }

      /** Whether an error means the panel should yield to another domain. */
      isDelegation(error) {
        return error === 'delegated'
      }
    }

    /**
     * One extra filing of a request under the Session the human is looking at.
     *
     * It is a copy, not a second owner: decisions, delegation and the request's
     * own seat all stay with the primary filing, so answering from either seat
     * settles the one call and releasing the copy can never disturb the other.
     */
    class PendingHitlView {
      constructor(primary, sessionId) {
        this.kind = KIND
        this.key = `${primary.key}@view`
        this.sessionId = sessionId
        this.primary = primary
      }

      get request() { return this.primary.request }
      get sequence() { return this.primary.sequence }
      get answerable() { return this.primary.answerable }
      answer(decision) { return this.primary.answer(decision) }
      delegate() { return Promise.resolve() }
      isDelegation(error) { return this.primary.isDelegation(error) }
    }

    // ── view ─────────────────────────────────────────────────────────────────

    /** Small error boundary: a panel bug must not blank the composer. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('dsh-hitl: panel crashed', error)
      }

      render() {
        if (this.state.failed) {
          // `null` means silence: a frame-level surface that cannot draw itself
          // must not leave an empty box floating over the application.
          if (this.props.fallback === null) return null
          return h('div', { className: 'dsh-hitl-panel' },
            h('div', { className: 'dsh-hitl-title' }, this.props.fallback),
          )
        }
        return this.props.children
      }
    }

    /** Largest height an auto-growing editor reaches before it scrolls instead. */
    const TEXTAREA_MAX_PX = 320

    /**
     * Nearest ancestor that actually scrolls, or undefined outside a browser or
     * when nothing scrolls. Switching a field from its preview to its editor
     * changes the height of everything below it, and a scroll container clamps a
     * position it can no longer reach; the switch therefore has to put the
     * position back.
     * @param element - the element whose ancestors are searched.
     * @returns the scrollable ancestor, when there is one.
     */
    function scrollableAncestor(element) {
      if (element === undefined || element === null || typeof getComputedStyle !== 'function') return undefined
      let node = element.parentElement
      while (node !== undefined && node !== null) {
        const overflowY = getComputedStyle(node).overflowY
        if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
        node = node.parentElement
      }
      return undefined
    }

    /**
     * Whether one field's render area accepts input: the field must say it is
     * editable AND the panel must still be taking decisions. A field whose
     * producer sent no `editable` flag stays read-only.
     * @param field - one wire field.
     * @param panelEditable - whether the panel is idle, unexpired, and unsubmitted.
     * @returns whether the field renders an editor.
     */
    function isFieldEditable(field, panelEditable) {
      return panelEditable === true && field?.editable === true
    }

    /**
     * Whether one field's header may claim the field is editable.
     *
     * The header must never promise more than the control under it offers. The
     * field's own flag is not the whole answer: while the panel is submitting,
     * settled, or past its deadline, every render area is inert — a `text` field
     * turns into a read-only block there — so the header has to follow the panel,
     * not the field's intent.
     *
     * @param field - one wire field.
     * @param panelEditable - whether the panel is idle, unexpired, and unsubmitted.
     * @returns whether the header says "editable"; everything else reads "read-only".
     */
    function claimsEditable(field, panelEditable) {
      return field?.render !== 'diff' && isFieldEditable(field, panelEditable)
    }

    /**
     * One-line-high textarea that grows with its content up to a capped height.
     *
     * The height is applied in a layout effect, before the browser paints: a
     * post-paint effect would expose one frame of a one-line box, which shrinks
     * the enclosing scroll area and makes the browser clamp its scroll position
     * back toward the top.
     */
    function AutoTextarea({ value, disabled, placeholder, ariaLabel, onChange, onFocus, onBlur }) {
      const ref = React.useRef(undefined)
      React.useLayoutEffect(() => {
        const element = ref.current
        if (element === undefined || element === null) return
        element.style.height = 'auto'
        element.style.height = `${Math.min(element.scrollHeight, TEXTAREA_MAX_PX)}px`
      }, [value])
      return h('textarea', {
        ref,
        className: 'dsh-hitl-textarea',
        value,
        rows: 1,
        spellCheck: false,
        disabled,
        ...(placeholder === undefined ? {} : { placeholder }),
        'aria-label': ariaLabel,
        onChange: event => { onChange(event.target.value) },
        onFocus,
        onBlur,
      })
    }

    /** Read-only JSON or read-only text view. */
    function JsonField({ field }) {
      return h('pre', { className: 'dsh-hitl-pre', 'aria-label': field.title }, field.value)
    }

    /** Editable plain-text proposal field. */
    function TextField({ field, value, disabled, onChange, onFocus, onBlur }) {
      return h(AutoTextarea, {
        value,
        disabled,
        ariaLabel: field.title,
        onChange,
        onFocus,
        onBlur,
      })
    }

    /**
     * Markdown field with an edit / preview / side-by-side switch.
     *
     * It opens on the rendered preview: a decision panel is read before it is
     * edited, and the editor is one click away on the field's own tabs. A
     * read-only markdown field keeps a selectable source pane — a block, not a
     * disabled input — and drops the edit view entirely.
     */
    function MarkdownField({ field, value, editable, t, onChange, onFocus, onBlur }) {
      const [mode, setMode] = React.useState('preview')
      const rootRef = React.useRef(undefined)
      const anchorRef = React.useRef(undefined)
      // Runs before paint, so the restored position is the one the reader sees.
      React.useLayoutEffect(() => {
        const anchor = anchorRef.current
        if (anchor === undefined) return
        anchorRef.current = undefined
        const scroller = scrollableAncestor(rootRef.current)
        if (scroller !== undefined) scroller.scrollTop = anchor
      }, [mode])
      const switchMode = id => {
        const scroller = scrollableAncestor(rootRef.current)
        anchorRef.current = scroller === undefined ? undefined : scroller.scrollTop
        setMode(id)
      }
      const html = React.useMemo(() => renderMarkdownHtml(value), [value])
      const tab = (id, label) => h('button', {
        key: id,
        type: 'button',
        className: `dsh-hitl-tab${mode === id ? ' is-active' : ''}`,
        onClick: () => { switchMode(id) },
      }, label)
      const editor = editable
        ? h(AutoTextarea, {
          value,
          disabled: false,
          ariaLabel: t('aria.field', { title: field.title }),
          onChange,
          onFocus,
          onBlur,
        })
        // A read-only source pane is a block, not a disabled input: disabled
        // text is neither selectable nor copyable in a browser, and the panel
        // would be showing text it refuses to let anyone take away.
        : h('pre', {
          className: 'dsh-hitl-pre',
          'aria-label': t('aria.field', { title: field.title }),
        }, value)
      const preview = h('div', {
        className: 'dsh-hitl-markdown',
        // Every tag here is emitted by renderMarkdownHtml, which escapes first.
        dangerouslySetInnerHTML: { __html: value.trim() === '' ? `<p class="dsh-hitl-p">${escapeHtml(t('markdown.empty'))}</p>` : html },
      })
      const modes = editable ? ['preview', 'edit', 'split'] : ['preview', 'split']
      const labels = { edit: t('markdown.edit'), preview: t('markdown.preview'), split: t('markdown.split') }
      return h('div', { className: 'dsh-hitl-md', ref: rootRef },
        h('div', { className: 'dsh-hitl-tabs', role: 'tablist' }, modes.map(id => tab(id, labels[id]))),
        mode === 'edit' ? editor : null,
        mode === 'preview' ? preview : null,
        mode === 'split' ? h('div', { className: 'dsh-hitl-md-split' }, editor, preview) : null,
      )
    }

    /** Read-only side-by-side diff. */
    function DiffField({ field, t }) {
      const diff = field.diff ?? { path: undefined, oldText: '', newText: '' }
      const computed = React.useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
      const head = h('div', { className: 'dsh-hitl-diff-head' },
        diff.path === undefined || diff.path === '' ? t('label.diffPlain') : t('label.diffChanged', { path: diff.path }),
        computed === undefined ? ` · ${t('error.diffTooLarge')}` : ` · +${computed.added} −${computed.removed}`,
      )
      if (computed === undefined) {
        return h('div', { className: 'dsh-hitl-diff' },
          head,
          h('div', { className: 'dsh-hitl-diff-grid' },
            h('pre', { className: 'dsh-hitl-pre' }, diff.oldText),
            h('pre', { className: 'dsh-hitl-pre' }, diff.newText),
          ),
        )
      }
      const cell = (entry, type) => h('div', {
        key: `${type}-${entry === null ? 'blank' : entry.number}`,
        className: `dsh-hitl-diff-line is-${entry === null ? 'blank' : type}`,
      },
      h('span', { className: 'dsh-hitl-diff-number' }, entry === null ? '' : String(entry.number)),
      h('span', { className: 'dsh-hitl-diff-text' }, entry === null ? '' : entry.text === '' ? ' ' : entry.text),
      )
      return h('div', { className: 'dsh-hitl-diff' },
        head,
        h('div', { className: 'dsh-hitl-diff-grid' },
          h('div', { className: 'dsh-hitl-diff-side' }, computed.rows.map(row => cell(row.left, row.type === 'removed' ? 'removed' : 'same'))),
          h('div', { className: 'dsh-hitl-diff-side' }, computed.rows.map(row => cell(row.right, row.type === 'added' ? 'added' : 'same'))),
        ),
      )
    }

    /** One field: its labels, its title, and its render area. */
    function FieldBlock({ field, drafts, panelEditable, t, onChange, onFocus, onBlur }) {
      if (field.render === 'hidden') return null
      const value = drafts[field.param] ?? field.value ?? ''
      const editable = isFieldEditable(field, panelEditable)
      const set = next => { onChange(field.param, next) }
      let area
      if (field.render === 'diff') area = h(DiffField, { field, t })
      else if (field.render === 'json') area = h(JsonField, { field })
      else if (field.render === 'text') {
        // A read-only text field is a block, not a disabled input: it carries no
        // affordance the panel would then have to refuse.
        area = editable
          ? h(TextField, { field, value, disabled: false, onChange: set, onFocus, onBlur })
          : h(JsonField, { field })
      } else area = h(MarkdownField, { field, value, editable, t, onChange: set, onFocus, onBlur })
      return h('section', { className: 'dsh-hitl-field', key: field.param },
        h('div', { className: 'dsh-hitl-field-head' },
          h('span', { className: 'dsh-hitl-field-title' }, field.title),
          h('span', { className: 'dsh-hitl-field-hint' },
            claimsEditable(field, panelEditable) ? t('label.editable') : t('label.readonly')),
          field.truncated === true ? h('span', { className: 'dsh-hitl-field-warn' }, t('label.truncated')) : null,
          ...(field.labels ?? []).map(label => h('span', { className: 'dsh-hitl-chip', key: label }, label)),
        ),
        field.description === undefined ? null : h('div', { className: 'dsh-hitl-field-desc' }, field.description),
        area,
      )
    }

    /**
     * The decision panel itself.
     * @param props - chain props (`matched`), locale `t`, and the injected store face.
     */
    function HitlPanel(props) {
      const t = props.t ?? (props.hitl?.t ?? ((key) => key))
      const store = props.hitl?.store
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      const pending = props.matched
      const request = snapshot.requests.find(entry => entry.id === pending.key) ?? pending.request
      const deadline = React.useRef(undefined)
      const [now, setNow] = React.useState(() => Date.now())
      const [drafts, setDrafts] = React.useState({})
      const [feedback, setFeedback] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState()
      const [settled, setSettled] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState(collapsePreference.collapsed)
      const [focusFeedback, setFocusFeedback] = React.useState(false)
      const feedbackRef = React.useRef(undefined)
      const frozenRemaining = React.useRef(undefined)
      const held = React.useRef(false)

      // Every frame carries the host's own remainder, so each fresh reading is
      // authoritative: re-base the local deadline instead of trusting the one
      // taken when this panel first appeared.
      // Whether the host granted this hold. It gates both the label and the
      // freeze, and it is read before the reading block because a reading that
      // arrives while frozen is the host moving its own remainder.
      const hostHeld = snapshot.holds?.[request.id] === true
      const revision = snapshot.revisions?.[request.id] ?? 0
      if (deadline.current === undefined || deadline.current.id !== request.id || deadline.current.revision !== revision) {
        const anchored = deadlineOf(request, Date.now())
        deadline.current = { id: request.id, revision, at: anchored }
        // A reading is adopted exactly once, on the frame that delivers it: the
        // frozen base must hold still afterwards, or the pause would keep
        // counting down while claiming to be paused.
        frozenRemaining.current = hostHeld && anchored !== undefined
          ? { id: request.id, remainingMs: Math.max(0, anchored - Date.now()) }
          : undefined
      }

      React.useEffect(() => {
        if (deadline.current.at === undefined) return undefined
        const timer = setInterval(() => { setNow(Date.now()) }, 1000)
        return () => { clearInterval(timer) }
      }, [request.id])

      // This panel is the composer seat for as long as it is mounted. The
      // frame-level notice reads that claim: while a seat is held there is no
      // request this page cannot answer from somewhere.
      const seat = props.hitl?.seat
      React.useEffect(() => {
        if (seat === undefined || seat === null) return undefined
        return seat.hold(pending.sessionId)
      }, [seat, pending.sessionId])

      // Holding the seat is a claim about reachability, so it is re-tested rather
      // than assumed: a modal can cover this panel without unmounting it, and the
      // frame-level notice takes over exactly then.
      const panelRef = React.useRef(undefined)
      React.useEffect(() => {
        if (seat === undefined || seat === null || typeof seat.reportObscured !== 'function') return undefined
        const probe = () => { seat.reportObscured(isObscured(panelRef.current)) }
        probe()
        const timer = setInterval(probe, OBSCURE_POLL_MS)
        return () => { clearInterval(timer) }
      }, [seat, pending.sessionId])

      // A different request takes this seat: start its draft state clean.
      React.useEffect(() => {
        setDrafts({})
        setFeedback('')
        setFailure(undefined)
        setSettled(false)
        setBusy(false)
        held.current = false
      }, [request.id])

      const fields = request.fields ?? []
      const changed = changedFields(fields, drafts)
      const edited = changed.length > 0
      const primaryText = settled || busy ? t('button.submitting') : primaryLabel(edited, request, t)
      const feedbackConfig = request.buttons?.feedback ?? { enabled: false, required: false }
      // The seat is filed under the displayed Session even for a delegated
      // call, so every other live request is reachable through this panel.
      const queued = snapshot.requests.filter(entry => entry.id !== request.id
        && snapshot.outcomes?.[entry.id] === undefined).length
      const foreign = isForeignRequest(request, pending.sessionId)
      const gotoSession = props.hitl?.canNavigate?.() === true ? props.hitl?.openSession : undefined
      // Set while a closed request is being shown for its reading time: the host
      // already settled it, so nothing here may still offer a decision.
      const outcome = snapshot.outcomes?.[request.id]

      // Hold bookkeeping is derived during the render, not in an effect: a
      // release must re-base the deadline on the same frame that stops showing
      // the frozen number. An effect runs after the render, so the frame in
      // between would draw the raw — already past — deadline and read as "the
      // pause and the countdown disagree".
      const clock = reconcileClock({
        id: request.id,
        at: deadline.current.at,
        frozen: frozenRemaining.current,
        hostHeld,
        now,
      })
      deadline.current.at = clock.at
      frozenRemaining.current = clock.frozen
      const remaining = clock.remaining
      const timedOut = remaining !== undefined && remaining <= 0
      const editable = outcome === undefined && !busy && !settled && !timedOut
      const tone = countdownTone(remaining, hostHeld, timedOut || outcome === 'timeout')

      // A collapse is remembered for the next request: a long panel must not
      // keep hiding the transcript behind it every time a decision arrives.
      const toggleCollapsed = () => {
        setCollapsed((current) => {
          collapsePreference.collapsed = !current
          return !current
        })
      }

      // A rejection that can carry words reopens the proposal first, so the
      // feedback box is never out of reach while the panel is collapsed.
      React.useEffect(() => {
        if (!focusFeedback) return
        const element = feedbackRef.current
        if (element === undefined || element === null) return
        element.focus()
        setFocusFeedback(false)
      }, [focusFeedback, collapsed])

      const setHold = next => {
        if (held.current === next) return
        held.current = next
        props.hitl?.connection?.hold(request.id, next)
      }
      const onFocus = () => { setHold(true) }
      const onBlur = () => { setHold(false) }
      const onChange = (param, text) => { setDrafts(current => ({ ...current, [param]: text })) }

      const submit = decision => {
        setBusy(true)
        setFailure(undefined)
        setHold(false)
        pending.answer(decision)
          .then(() => {
            setSettled(true)
            setTimeout(() => {
              if (!store.request(request.id)) return
              store.settle(request.id, 'user')
            }, SETTLE_GRACE_MS)
          })
          .catch(error => {
            setBusy(false)
            setFailure(error?.message ?? String(error))
          })
      }

      const onApprove = () => {
        if (edited) submit({ kind: 'modify', fields: changed })
        else submit({ kind: 'approve' })
      }
      const onReject = () => {
        if (collapsed && feedbackConfig.enabled === true) {
          // The words belong to the rejection: reopen, then let the human type.
          setCollapsed(false)
          setFocusFeedback(true)
          return
        }
        if (feedbackConfig.required === true && feedback.trim() === '') {
          setFailure(t('feedback.required'))
          return
        }
        submit(feedback.trim() === '' ? { kind: 'reject' } : { kind: 'reject', feedback: feedback.trim() })
      }
      const onRetry = () => { setBusy(false); setFailure(undefined) }

      const title = request.title ?? t('title.default', { tool: request.toolName })
      const countdownText = remaining === undefined
        ? undefined
        : (timedOut || outcome === 'timeout'
          ? t('label.timeout')
          : (hostHeld ? t('label.countdownHeld', { seconds: formatRemaining(remaining) }) : t('label.countdown', { seconds: formatRemaining(remaining) })))
      const connectionNote = snapshot.connection === 'unavailable'
        ? t('label.offlineNoToken')
        : (snapshot.connection === 'open' ? undefined : t('label.offline'))
      const collapseLabel = collapsed ? t('aria.expand') : t('aria.collapse')
      const chevron = h('button', {
        type: 'button',
        className: 'dsh-hitl-chevron',
        onClick: toggleCollapsed,
        'aria-expanded': collapsed ? 'false' : 'true',
        'aria-label': collapseLabel,
        title: collapseLabel,
      }, h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: collapsed ? 'M4 9.5 8 5.5 12 9.5' : 'M4 6.5 8 10.5 12 6.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })),
      h('span', { className: 'dsh-hitl-chevron-label' }, collapsed ? t('button.expand') : t('button.collapse')))

      return h(PanelBoundary, { fallback: t('label.offlineNoToken') },
        h('div', {
          ref: panelRef,
          className: 'dsh-hitl-panel',
          role: 'dialog',
          'aria-label': t('aria.dialog', { tool: request.toolName }),
          'data-timed-out': timedOut ? 'true' : undefined,
          'data-collapsed': collapsed ? 'true' : undefined,
        },
        h('style', null, CSS),
        h('div', { className: 'dsh-hitl-head' },
          h('h2', { className: 'dsh-hitl-title' }, title),
          chevron,
        ),
        h('div', { className: 'dsh-hitl-meta' },
          h('span', { className: 'dsh-hitl-tool' }, request.toolName),
          ...(request.labels ?? []).map(label => h('span', { className: 'dsh-hitl-chip', key: label }, label)),
          foreign
            ? h('span', { className: 'dsh-hitl-chip is-foreign' },
              t('label.foreign', { session: shortSession(request.sessionId) }))
            : null,
          foreign && typeof gotoSession === 'function'
            ? h('button', {
              type: 'button',
              className: 'dsh-hitl-btn is-ghost',
              onClick: () => { gotoSession(request.sessionId) },
            }, t('button.gotoSession'))
            : null,
          queued > 0 ? h('span', { className: 'dsh-hitl-queued' }, t('label.queued', { count: queued })) : null,
          connectionNote === undefined ? null : h('span', { className: 'dsh-hitl-offline' }, connectionNote),
        ),
        collapsed ? null : h(React.Fragment, null,
          h('div', { className: 'dsh-hitl-fields', 'data-layout': request.layout ?? 'stacked' },
            fields.map(field => h(FieldBlock, {
              field,
              key: field.param,
              drafts,
              panelEditable: editable,
              t,
              onChange,
              onFocus,
              onBlur,
            })),
          ),
          edited ? h('div', { className: 'dsh-hitl-note' }, t('modify.note')) : null,
          feedbackConfig.enabled === true
            ? h('div', { className: 'dsh-hitl-feedback' },
              h('label', { className: 'dsh-hitl-feedback-title' }, t('feedback.title')),
              h('textarea', {
                ref: feedbackRef,
                className: 'dsh-hitl-textarea',
                value: feedback,
                rows: 2,
                spellCheck: false,
                disabled: !editable,
                placeholder: feedbackConfig.prompt ?? t('feedback.placeholder'),
                'aria-label': t('feedback.title'),
                onChange: event => { setFeedback(event.target.value) },
                onFocus,
                onBlur,
              }),
            )
            : null,
        ),
        failure === undefined ? null : h('div', { className: 'dsh-hitl-error' },
          t('error.submit', { message: failure }),
          h('button', { type: 'button', className: 'dsh-hitl-btn is-ghost', onClick: onRetry }, t('button.retry')),
        ),
        h('div', { className: 'dsh-hitl-actions' },
          countdownText === undefined ? null : h('span', { className: `dsh-hitl-countdown is-${tone}` }, countdownText),
          h('button', {
            type: 'button',
            className: 'dsh-hitl-btn is-outline',
            disabled: !editable,
            onClick: onReject,
          }, t('button.reject')),
          h('button', {
            type: 'button',
            className: 'dsh-hitl-btn is-primary',
            disabled: !editable,
            onClick: onApprove,
          }, primaryText),
        ),
        settled
          ? h('div', { className: 'dsh-hitl-settled' }, t('settled.byUser'))
          : (outcome === undefined
            ? null
            : h('div', { className: 'dsh-hitl-settled' },
              t(outcome === 'timeout' ? 'settled.byTimeout' : 'settled.byHost'))),
        ),
      )
    }

    /**
     * Frame-level notice for requests no composer can show.
     *
     * A composer seat exists only where a Conversation is on screen. With no
     * Session selected, another main panel open, or a shipped panel outranking
     * this one for the composer, a gated call — most often a subagent's — would
     * otherwise have no surface at all. This notice is that surface: it renders
     * whenever nothing holds the seat while requests are live, and offers the
     * two decisions that need no editing, plus a jump to the asking Session for
     * the full panel.
     *
     * @param props - slot props: locale `t` and this plugin's face.
     * @returns the notice element, or null while a seat or the settle delay covers it.
     */
    function HitlNotice(props) {
      const t = props.t ?? (props.hitl?.t ?? ((key) => key))
      const store = props.hitl?.store
      const seat = props.hitl?.seat
      const connection = props.hitl?.connection
      const gotoSession = props.hitl?.canNavigate?.() === true ? props.hitl?.openSession : undefined
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      const seatState = React.useSyncExternalStore(seat.subscribe, seat.getSnapshot)
      const [now, setNow] = React.useState(() => Date.now())
      const [shown, setShown] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState()
      const noticeRef = React.useRef(undefined)
      // A closed request being read is not a request to act on: the notice only
      // ever speaks for calls that can still be decided.
      const live = snapshot.requests ?? []
      const requests = live.filter(request => snapshot.outcomes?.[request.id] === undefined)
      const wanted = noticeVisible(requests, seatState)

      // A seat is claimed from a mount effect, which runs after paint: waiting
      // one beat keeps the notice from flashing over a panel that just arrived.
      React.useEffect(() => {
        if (!wanted) {
          setShown(false)
          return undefined
        }
        const timer = setTimeout(() => { setShown(true) }, NOTICE_DELAY_MS)
        return () => { clearTimeout(timer) }
      }, [wanted])

      // The notice exists for the moments when the composer is unreachable, and
      // the usual reason is a modal dialog — which is portaled to `body` with a
      // z-index far above the shell's overlay layer. The popover top layer is the
      // one place a plugin can paint from without fighting that stacking order;
      // where the API is missing, the in-frame position stays as it is.
      React.useEffect(() => {
        if (!shown) return undefined
        const element = noticeRef.current
        if (element === undefined || element === null || typeof element.showPopover !== 'function') return undefined
        try {
          if (element.matches(':popover-open') !== true) element.showPopover()
        } catch {
          /* an unsupported or already-open popover keeps its static position */
        }
        return undefined
      }, [shown])

      const ticking = shown && requests.some(request => deadlineOf(request, now) !== undefined)
      React.useEffect(() => {
        if (!ticking) return undefined
        const timer = setInterval(() => { setNow(Date.now()) }, 1000)
        return () => { clearInterval(timer) }
      }, [ticking])

      if (!shown || requests.length === 0) return null

      const head = requests[0]
      const rows = requests.slice(0, 3)
      const decide = decision => {
        if (typeof connection?.decide !== 'function') return
        setBusy(true)
        setFailure(undefined)
        connection.decide(head.id, decision)
          .then(() => { setBusy(false) })
          .catch(error => {
            setBusy(false)
            setFailure(error?.message ?? String(error))
          })
      }
      // The asking Session names itself: anything else on screen is somebody's
      // subagent, which is exactly what a human needs to know before deciding.
      const source = request => request.sessionId === store.getSnapshot().viewSessionId
        ? t('notice.own')
        : t('notice.subagent', { session: shortSession(request.sessionId) })

      // The notice is the last surface between a blocked call and silence, and
      // it renders in the shell's overlay layer: a bug here must degrade to
      // nothing, never take the frame down with it.
      return h(PanelBoundary, {
        fallback: null,
        children: h('div', {
          ref: noticeRef,
          className: 'dsh-hitl-notice',
          popover: 'manual',
          role: 'status',
          'aria-label': t('aria.notice'),
        },
      h('style', null, CSS),
      h('div', { className: 'dsh-hitl-notice-head' },
        h('span', { className: 'dsh-hitl-notice-title' }, t('notice.title', { count: requests.length })),
        h('span', { className: 'dsh-hitl-notice-hint' }, t('notice.hint')),
      ),
      h('ul', { className: 'dsh-hitl-notice-list' },
        rows.map(request => {
          const at = deadlineOf(request, now)
          const remaining = at === undefined ? undefined : at - now
          const timedOut = remaining !== undefined && remaining <= 0
          return h('li', { className: 'dsh-hitl-notice-row', key: request.id },
            h('span', { className: 'dsh-hitl-notice-tool' }, request.toolName),
            h('span', { className: 'dsh-hitl-notice-source' }, source(request)),
            remaining === undefined
              ? null
              : h('span', {
                className: `dsh-hitl-countdown is-${countdownTone(remaining, false, timedOut)}`,
              }, timedOut
                ? t('label.timeout')
                : t('label.countdown', { seconds: formatRemaining(remaining) })),
          )
        }),
        requests.length > rows.length
          ? h('li', { className: 'dsh-hitl-notice-row' }, t('notice.more', { count: requests.length - rows.length }))
          : null,
      ),
      failure === undefined ? null : h('div', { className: 'dsh-hitl-error' }, t('error.submit', { message: failure })),
      h('div', { className: 'dsh-hitl-notice-actions' },
        typeof gotoSession === 'function'
          ? h('button', {
            type: 'button',
            className: 'dsh-hitl-btn is-ghost',
            onClick: () => { gotoSession(head.sessionId) },
          }, t('button.gotoSession'))
          : null,
        h('button', {
          type: 'button',
          className: 'dsh-hitl-btn is-outline',
          disabled: busy,
          onClick: () => { decide({ kind: 'reject' }) },
        }, t('button.reject')),
        h('button', {
          type: 'button',
          className: 'dsh-hitl-btn is-primary',
          disabled: busy,
          onClick: () => { decide({ kind: 'approve' }) },
        }, busy ? t('button.submitting') : t('button.approve')),
      )),
      })
    }

    /** Component styles: theme tokens only, every class prefixed for this plugin. */
    const CSS = `
.dsh-hitl-panel{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-hitl-head{display:flex;align-items:flex-start;gap:8px}
.dsh-hitl-title{flex:1 1 auto;min-width:0;margin:0;font-size:14px;font-weight:600;line-height:1.5;overflow-wrap:anywhere;white-space:normal}
/* The countdown is a blocking deadline, so it reads as a chip, never as faint text. */
.dsh-hitl-countdown{flex:none;display:inline-flex;align-items:center;padding:2px 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-hitl-countdown.is-held{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:500}
.dsh-hitl-countdown.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);animation:dsh-hitl-pulse 1.4s ease-in-out infinite}
.dsh-hitl-countdown.is-timeout{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
@keyframes dsh-hitl-pulse{0%,100%{opacity:1}50%{opacity:.6}}
@media (prefers-reduced-motion:reduce){.dsh-hitl-countdown.is-warn{animation:none}}
.dsh-hitl-chevron{flex:none;display:inline-flex;align-items:center;gap:3px;height:22px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}
.dsh-hitl-chevron:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-hitl-chevron:focus-visible{outline:none;border-color:var(--dsw-alias-button-primary-fill)}
.dsh-hitl-panel[data-collapsed="true"]{gap:8px}
.dsh-hitl-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-hitl-tool{font-family:var(--dsw-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}
.dsh-hitl-chip{padding:1px 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-hitl-queued,.dsh-hitl-offline{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.dsh-hitl-fields{display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow-x:hidden;overflow-y:auto;padding-right:2px}
.dsh-hitl-fields[data-layout="split"]{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.dsh-hitl-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-hitl-field-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dsh-hitl-field-title{font-weight:600;overflow-wrap:anywhere}
.dsh-hitl-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-hitl-field-warn{font-size:11px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary))}
.dsh-hitl-field-desc{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-hitl-textarea{width:100%;box-sizing:border-box;resize:none;overflow-y:auto;max-height:320px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:1.6}
.dsh-hitl-textarea:focus{outline:none;border-color:var(--dsw-alias-button-primary-fill)}
.dsh-hitl-textarea:disabled{opacity:.6;cursor:not-allowed}
.dsh-hitl-tabs{display:flex;gap:4px;margin-bottom:4px}
.dsh-hitl-tab{padding:2px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.dsh-hitl-tab.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-hitl-md-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}
.dsh-hitl-markdown,.dsh-hitl-pre{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:auto;max-height:320px}
.dsh-hitl-markdown{font-size:12px;line-height:1.7}
.dsh-hitl-pre{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
/* Host-markdown parity: same tokens the shipped renderer uses for inline code. */
.dsh-hitl-code{display:inline-flex;align-items:center;box-sizing:border-box;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:.875em;background-color:var(--dsw-alias-markdown-inline-code);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,4px);padding:0 5px}
.dsh-hitl-p{margin:0 0 8px}
.dsh-hitl-p:last-child{margin-bottom:0}
.dsh-hitl-h{margin:12px 0 6px;font-size:13px;font-weight:600;line-height:1.5}
.dsh-hitl-h:first-child{margin-top:0}
.dsh-hitl-list{margin:8px 0;padding-left:18px}
.dsh-hitl-list li:not(:first-child){margin-top:4px}
.dsh-hitl-list li::marker{color:var(--dsw-alias-label-secondary)}
.dsh-hitl-quote{margin:8px 0;padding-left:12px;border-left:2px solid var(--dsw-alias-label-caption);color:var(--dsw-alias-label-secondary)}
.dsh-hitl-hr{display:block;border:none;height:.5px;margin:16px 0;background:var(--dsw-alias-border-l2)}
.dsh-hitl-link{color:var(--dsw-alias-link)}
.dsh-hitl-diff{display:flex;flex-direction:column;gap:4px}
.dsh-hitl-diff-head{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-hitl-diff-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-border-l2);overflow:auto;max-height:320px}
.dsh-hitl-diff-side{background:var(--dsw-alias-bg-layer-2);min-width:0}
.dsh-hitl-diff-line{display:flex;gap:8px;padding:0 8px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-hitl-diff-line.is-added{background:var(--dsw-alias-code-diff-added)}
.dsh-hitl-diff-line.is-removed{background:var(--dsw-alias-code-diff-deleted)}
.dsh-hitl-diff-number{flex:none;width:3ch;text-align:right;color:var(--dsw-alias-label-tertiary)}
.dsh-hitl-diff-text{flex:1 1 auto;min-width:0}
.dsh-hitl-note{font-size:12px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.dsh-hitl-feedback{display:flex;flex-direction:column;gap:4px}
.dsh-hitl-feedback-title{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-hitl-error{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsh-hitl-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsh-hitl-actions .dsh-hitl-countdown{margin-right:auto}
.dsh-hitl-btn{padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid transparent}
.dsh-hitl-btn.is-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-label,var(--dsw-alias-bg-base))}
.dsh-hitl-btn.is-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-hitl-btn.is-outline{border-color:var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.dsh-hitl-btn.is-outline:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-hitl-btn.is-ghost{border:none;background:transparent;color:var(--dsw-alias-link);padding:2px 4px}
.dsh-hitl-btn:disabled{opacity:.55;cursor:not-allowed}
.dsh-hitl-settled{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-hitl-chip.is-foreign{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
/* Frame-level notice. It is promoted to the popover top layer when the browser
   supports it, so a modal's mask cannot hide it; fixed positioning keeps the same
   placement inside the shell's overlay layer when it is not. */
.dsh-hitl-notice{position:fixed;top:12px;left:50%;transform:translateX(-50%);margin:0;display:flex;flex-direction:column;gap:6px;width:min(620px,calc(100vw - 48px));padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 28px rgb(0 0 0 / 18%);color:var(--dsw-alias-label-primary);font-size:12px}
.dsh-hitl-notice-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.dsh-hitl-notice-title{font-weight:600}
.dsh-hitl-notice-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-hitl-notice-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dsh-hitl-notice-row{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-hitl-notice-tool{flex:none;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dsh-hitl-notice-source{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dsh-hitl-notice-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsh-hitl-notice-actions .dsh-hitl-btn.is-ghost{margin-right:auto}
`

    // ── plugin ───────────────────────────────────────────────────────────────

    /** Required client services: locale, slots, and the Session pending-interaction registry. */
    const inject = ['locale', 'slots', 'uiSession']

    /**
     * Client plugin body: dictionaries, the transport, the pending-interaction
     * domain, the composer-seat panel, and the frame-level fallback notice.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-hitl: zh dictionary')
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-hitl: en dictionary')
      const t = ctx.locale.bind(NS)
      const boot = typeof globalThis !== 'undefined' ? globalThis.__DSH_HITL__ : undefined
      const store = createStore()
      const connection = createConnection({ boot, store })
      const seat = createSeat()
      let sequence = 0
      const pendings = new Map()

      ctx.effect(() => () => { connection.dispose() }, 'dsh-hitl: decision transport')
      connection.start()

      // Which Session the composer chain renders. A pending interaction is only
      // ever elected for the displayed Session, so this value decides where a
      // delegated call's panel is allowed to appear.
      const readView = () => {
        const source = ctx.uiSession?.adapter?.current
        const binding = source === undefined || source === null ? undefined : source.value
        const id = binding === undefined || binding === null ? undefined : binding.key
        store.setView(typeof id === 'string' && id !== '' ? id : undefined)
      }
      ctx.effect(() => {
        const source = ctx.uiSession?.adapter?.current
        if (source === undefined || source === null || typeof source.subscribe !== 'function') return undefined
        readView()
        return source.subscribe(readView)
      }, 'dsh-hitl: displayed Session')

      // Jumping to the asking Session is a capability, not a requirement: the
      // workspace plugin owns navigation, so a profile without it keeps every
      // decision path and only loses the jump button.
      let navigate
      const canNavigate = () => typeof navigate === 'function'
      const navigateSession = id => { if (typeof navigate === 'function') navigate(id) }
      ctx.inject(['uiWorkspace'], (scope) => {
        navigate = id => { scope.uiWorkspace.openSession(id) }
        scope.effect(() => () => { navigate = undefined }, 'dsh-hitl: Session jump')
      })

      // One pending-interaction domain: a blocked tool call outranks the
      // shipped approval and question panels, and the oldest request wins the
      // seat so the earliest blocked call is the one being decided.
      const publish = ctx.uiSession.registerPendingInteraction(
        interaction => PRECEDENCE - (interaction.sequence ?? 0),
      )

      const face = () => ({
        hitl: { store, connection, seat, t, canNavigate, openSession: navigateSession },
      })

      const dropView = record => {
        const release = record.viewRelease
        record.viewRelease = undefined
        record.viewSessionId = undefined
        if (release === undefined) return
        try {
          release()
        } catch (error) {
          console.error('dsh-hitl: releasing a viewed-seat filing failed', error)
        }
      }

      // A request is filed under the Session that asked, and — when the human is
      // looking somewhere else — under the displayed Session too, so a subagent's
      // gated call meets the human wherever they are instead of waiting in a
      // child Session nobody has open.
      const syncViews = () => {
        const viewSessionId = store.getSnapshot().viewSessionId
        for (const record of pendings.values()) {
          const filings = filingSessions(record.primary.request, viewSessionId)
          const target = filings.length > 1 ? filings[1] : undefined
          if (record.viewSessionId === target) continue
          dropView(record)
          if (target === undefined) continue
          const view = new PendingHitlView(record.primary, target)
          record.viewSessionId = target
          record.viewRelease = publish(view, () => view.delegate())
        }
      }

      const publishRequest = request => {
        const existing = pendings.get(request.id)
        if (existing !== undefined) {
          existing.primary.request = request
          return existing
        }
        sequence += 1
        const primary = new PendingHitl(request, connection, sequence)
        const record = { primary, viewSessionId: undefined, viewRelease: undefined }
        record.primaryRelease = publish(primary, () => primary.delegate())
        pendings.set(request.id, record)
        syncViews()
        return record
      }

      const unpublish = id => {
        const record = pendings.get(id)
        if (record === undefined) return
        pendings.delete(id)
        store.remove(id)
        dropView(record)
        try {
          record.primaryRelease?.()
        } catch (error) {
          console.error('dsh-hitl: releasing a pending decision failed', error)
        }
      }

      const stopStore = store.subscribe(() => {
        const snapshot = store.getSnapshot()
        for (const request of snapshot.requests) publishRequest(request)
        for (const id of [...pendings.keys()]) {
          if (!snapshot.requests.some(request => request.id === id)) unpublish(id)
        }
        syncViews()
      })
      ctx.effect(() => () => {
        stopStore()
        for (const id of [...pendings.keys()]) unpublish(id)
      }, 'dsh-hitl: mirrored pending requests')

      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: CHAIN_PRIORITY,
        select: ({ pendingInteraction }) => pendingInteraction instanceof PendingHitl
          || pendingInteraction instanceof PendingHitlView
          ? pendingInteraction
          : null,
        locale: NS,
        inject: face,
      }, HitlPanel))

      // Frame-level fallback for the requests no composer can reach: no Session
      // selected, another main panel on screen, or a shipped panel outranking
      // this one. Registered by id so it never displaces another overlay entry.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-hitl.notice',
        locale: NS,
        inject: face,
      }, HitlNotice))
    }

    return {
      inject,
      apply,
      /** Pure helpers, exported for the host-side tests of this file. */
      __test: { escapeHtml, renderMarkdownHtml, diffLines, formatRemaining, primaryLabel, changedFields, isFieldEditable, countdownTone, streamStale, deadlineOf, reconcileClock, shortSession, filingSessions, isForeignRequest, noticeVisible, createSeat, isObscured, claimsEditable, PendingHitl, PendingHitlView, createStore, createConnection, zh, en },
    }
  },
})
