/**
 * The activity card: what a run is doing, while it is doing it.
 *
 * A long turn is otherwise silent. The phone hears from this plugin only when a request
 * blocks or a turn ends, so the only way to know whether the machine is still working — and
 * where it is — is to go and look at the desk, which is the thing this plugin exists so that
 * nobody has to do.
 *
 * The card is one message per session, rewritten in place and never re-sent. That is not a
 * preference: a bot cannot send a message without notifying, and updating one it already sent
 * is silent — measured on a real tenant. So the card is *sent once*, when a run starts with the
 * phone holding the person, and everything after that is an edit. A card that cannot announce
 * itself is a card that cannot become noise.
 *
 * Two consequences shape the rest of it:
 *
 * - **It carries no controls at all.** No buttons, no inputs, no collapsible panel. A card
 *   being interacted with cannot be updated, and being updated is this card's whole job;
 *   leaving the surface inert is what keeps an interaction from ever meeting an edit.
 * - **Edits are limited to one per {@link REFRESH_MS}.** Feishu allows five updates per second
 *   to one message, and a long answer produces hundreds of text deltas — far more than that.
 *   Deltas are accumulated and the card is rewritten on a trailing window, so the reader
 *   watches the text grow at a readable pace instead of a stream that would be throttled into
 *   being permanently behind.
 *
 * Only phone priority mints a card. While the desk has the person, the run is visible where
 * they are, and a message nothing would be looking at is a message nobody asked for.
 *
 * @module pocket-console/activity
 */

import { clipToBytes } from './budget.js'
import { titleOf, workspaceLabel } from './identity.js'
import { PHONE } from './priority.js'

import { randomUUID } from 'node:crypto'

/**
 * The shortest interval between two edits of one card.
 *
 * Feishu permits five updates per second to a single message; a quarter second sits inside
 * that with room for whatever else this deployment sends from the same identity.
 */
const REFRESH_MS = 250

/**
 * How often the card is rewritten while a step is silent, so its clock keeps moving.
 *
 * A model that has gone quiet must not read as stopped: the elapsed time is the thing on this
 * card that answers "is it still going", and it has to keep answering while no delta arrives —
 * which is exactly when a reader looks.
 */
const CLOCK_MS = 5_000

/**
 * How long to wait before trying a failed send again.
 *
 * Long enough that a channel which is down is not hammered at the refresh rate, and long
 * enough that a response lost after the platform accepted the card is not answered with a
 * second card within the moment a reader would notice. Short enough that a transient failure
 * still gets the card out while the run it describes is worth looking at.
 */
const RETRY_MS = 5_000

/** Sessions shown at once before the coldest are forgotten. */
const CAPACITY = 64

/** How many of the newest deltas the card keeps. */
const RECENT_FRAGMENTS = 3

/**
 * How much of a finished run's process the folded record keeps.
 *
 * The panel is the only place a reader can see what a run did, so it is worth more room than the
 * card face — but not unbounded: a run of a hundred steps would otherwise put a document into one
 * message, and a card that cannot be delivered says nothing at all.
 */
const PROCESS_BUDGET = 8 * 1024

/**
 * Create the activity card.
 * @param options - the logger, the channel, the settings, copy, priority, and the workspace
 *   registry every delivered card is remembered in.
 * @returns installation, the event feed, and what a priority change does to the card.
 */
export function createActivity({
  ctx, log, channel, settings, messages, priority, workspaces, now = () => Date.now(),
}) {
  /** One record per session being shown: what it is doing, and the message its card lives in. */
  const activities = new Map()
  /** Set while an edit is scheduled, so a run of deltas collapses into one. */
  let refreshTimer
  /** Set while the slow clock tick is scheduled. */
  let clockTimer
  /** Set once the module is disposed, so a pending edit does not outlive it. */
  let disposed = false

  /** Whether the phone holds the person, which is the only condition that mints a card. */
  const phoneHasIt = () => priority?.get() === PHONE

  /**
   * One session's record, created on first sight.
   *
   * The map is bounded because a record is small but permanent otherwise. What it forgets is the
   * **least recently used**, not the earliest created: a session that started long ago and is
   * streaming right now would otherwise be evicted out from under its own live card, leaving that
   * card frozen and giving the session a second message on its next turn. Re-inserting on every
   * touch is what makes the first key the coldest one, the same rule the workspace registry uses.
   * @param session - the session id.
   * @returns its record.
   */
  const recordOf = (session) => {
    const known = activities.get(session)
    if (known !== undefined) {
      // Moved to the end, so the oldest key is the least recently used one — but only while there
      // is room to move it. At the cap, moving a key that is already last would first remove it
      // and then find no room to put it back, and a live session would lose its card for good.
      if (activities.size < CAPACITY) {
        activities.delete(session)
        activities.set(session, known)
      }
      return known
    }

    // A session nobody is following yet: make room for it, then take the newest place.
    if (activities.size >= CAPACITY) activities.delete(activities.keys().next().value)
    const record = {
      session,
      handle: undefined,
      sending: false,
      dirty: false,
      /** When a failed send may be tried again, so a dead channel is not hammered. */
      retryAt: undefined,
      /** The idempotency key this card is sent under, so a retry cannot become a second card. */
      uuid: undefined,
      /**
       * What this run has said and done, in the order it happened.
       *
       * Kept for the frozen card's folded record: it is what a reader opens when they want to
       * know what a finished run actually did, and it is built while the run goes because there
       * is nothing to re-read it from afterwards.
       */
      process: [],
      /** Set once a newer card for this session exists, so a frozen card can say so. */
      superseded: false,
      workspace: undefined,
      turn: undefined,
      step: undefined,
      tool: undefined,
      fragments: [],
      failed: undefined,
      startedAt: now(),
      settled: false,
    }
    activities.set(session, record)
    return record
  }

  /** The workspace one session belongs to, read once and carried like every other card. */
  const workspaceOf = (session) => workspaceLabel(ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd)

  /**
   * Add one thing the run did to the record the frozen card will carry.
   *
   * The oldest entries go first when the record is full: the end of a run is what a reader is
   * looking for, and a record that stopped mid-way would be the least useful half of it.
   * @param record - the session's record.
   * @param line - one message's text, or one line about a failure.
   */
  const note = (record, line) => {
    const text = String(line ?? '').trim()
    if (text === '') return
    record.process.push(text)
    let size = record.process.reduce((total, entry) => total + Buffer.byteLength(entry, 'utf8'), 0)
    while (size > PROCESS_BUDGET && record.process.length > 1) {
      size -= Buffer.byteLength(record.process[0], 'utf8')
      record.process.shift()
    }
  }

  /**
   * What the run is doing, in one word.
   *
   * Read from the agent rather than derived from the log: the log is the record of what
   * happened, and this is a question about now.
   * @param record - the session's record.
   * @param copy - the copy table in force.
   * @returns the status line.
   */
  const statusOf = (record, copy) => {
    // A failure outranks the turn being over: every failed turn ends, and reporting the end
    // instead of the failure would hide the one thing the reader has to act on.
    if (record.failed !== undefined) return copy.activityError
    if (record.settled) return copy.activityFrozen
    if (record.tool !== undefined) return copy.activityWaiting
    return copy.activityRunning
  }

  /**
   * The folded record of a finished run, when there is one to fold.
   *
   * Only a settled card carries it: while a run is going the live fragments are the point, and a
   * panel that changed under the reader's thumb would be worse than no panel. A frozen card is
   * the one place a reader goes looking for what actually happened.
   * @param record - the session's record.
   * @param copy - the copy table in force.
   * @returns the panel, or undefined when the card is live or has nothing to show.
   */
  const detailsFor = (record, copy) => {
    if (!record.settled || record.process.length === 0) return undefined
    return {
      title: copy.activityProcess,
      // Folded content gets the whole card's room: nothing else has to fit beside it, and the
      // reason to open it is to read what the run did.
      blocks: [clipToBytes(record.process.join('\n\n'), copy.truncated)],
    }
  }

  /**
   * Render one session's card.
   * @param record - the session's record.
   * @returns the channel-neutral view.
   */
  const buildView = (record) => {
    const copy = messages()
    const parts = [statusOf(record, copy)]
    // The step is named only once it is known: a turn that has started but whose first step
    // has not been announced yet has no step number, and printing one would print `undefined`.
    if (record.turn !== undefined && record.step !== undefined) {
      parts.push(copy.activityStep(record.turn, record.step))
    } else if (record.turn !== undefined) {
      parts.push(copy.activityTurn(record.turn))
    }
    parts.push(copy.activityElapsed(Math.max(0, Math.round((now() - record.startedAt) / 1000))))
    const body = [`**${parts.join(' · ')}**`]
    if (record.tool !== undefined) body.push(copy.activityTool(record.tool))
    if (record.failed !== undefined) {
      body.push(copy.activityFailed(clipToBytes(record.failed, copy.truncated, 600)))
    }
    // The newest of the stream, not the whole of it: the card is for glancing at, and the turn's
    // actual answer is what the result notice is for.
    const text = record.fragments.join('')
    body.push(text === '' ? copy.activityNothingYet : clipToBytes(text, copy.truncated))
    // A frozen card says a newer one exists, so a reader who scrolled back knows to look below
    // rather than reply against a run that is over.
    if (record.settled && record.superseded) body.push(copy.activitySuperseded)
    const details = detailsFor(record, copy)
    return {
      title: titleOf(`${settings().titlePrefix} ${copy.activityTitle}`, record.workspace),
      tone: record.failed !== undefined ? 'danger' : record.settled ? 'muted' : 'info',
      body,
      // The record of what the run did, folded where the channel can fold it. Absent while the
      // run is live: a panel that grows under the reader's thumb is worse than no panel.
      ...(details === undefined ? {} : { details }),
      // Nothing to press: this card exists to be looked at, and a control on it could meet an
      // edit while it is being used.
      buttons: [],
      forms: [],
    }
  }

  /** Schedule the next write, unless one is already pending. */
  const armRefresh = () => {
    if (disposed || refreshTimer !== undefined) return
    refreshTimer = setTimeout(flush, REFRESH_MS)
    refreshTimer.unref?.()
  }

  /**
   * Write out every card whose contents moved.
   *
   * Sends the first version and edits every one after it: the send is the only notification
   * this card ever produces. A card the reader is not supposed to see — because the desk took
   * the person back while the edit was queued, or because the run started while the desk had
   * them — is not written at all here, since the window between deciding and writing is long
   * enough for the situation to change under it.
   */
  const flush = () => {
    refreshTimer = undefined
    if (disposed) return
    const at = now()
    let requeue = false
    for (const record of activities.values()) {
      if (!record.dirty) continue
      // Held back while a send is in flight, and while a send that failed is waiting its turn:
      // dropping the flag instead would lose whatever changed in the meantime, which for a
      // turn that ended mid-send means a card that says "working" for good.
      if (record.sending || (record.retryAt ?? 0) > at) {
        requeue = true
        continue
      }
      if (!phoneHasIt()) {
        // The desk has the person. A card that exists keeps its last state — it is a record of
        // a run, and taking it away would take away the answer to "what was it doing" — and one
        // that was never sent is not sent now, because a message the desk is not expecting is
        // exactly the notification this plugin does not send.
        record.dirty = false
        continue
      }
      record.dirty = false
      const view = buildView(record)
      if (record.handle === undefined) {
        // A send the platform accepted but whose answer was lost is the one way this card could
        // become two messages — and two messages mean two notifications for one run. The key is
        // what stops it: a channel that can carry one keeps the platform from accepting the same
        // card twice, and a channel that cannot is kept from a second *attempt* only by the
        // answer itself, which is why a delivered id is never sent again.
        record.sending = true
        record.uuid ??= randomUUID()
        void Promise.resolve(channel.deliver(view, { uuid: record.uuid })).then((handle) => {
          record.handle = handle
          record.sending = false
          record.retryAt = undefined
          // Remembered against the message as well, so a card rewritten without its record —
          // after a restart — can still name the session it belongs to.
          workspaces?.record(handle, record.workspace)
          log.info(messages().logActivitySent)
        }).catch((error) => {
          record.sending = false
          // An answer that never arrived is the one failure worth retrying: the card may or may
          // not exist, and the key is what makes trying again safe. A channel that is down is
          // waited out rather than hammered at the refresh rate.
          record.retryAt = now() + RETRY_MS
          record.dirty = true
          log.warn(messages().logActivitySendFailed, error)
        })
        continue
      }
      void Promise.resolve(channel.update(record.handle, view))
        .catch(error => { log.warn(messages().logActivityUpdateFailed, error) })
    }
    if (requeue) armRefresh()
  }

  /** Ask for an edit, at most once per refresh window. */
  const touch = () => {
    if (disposed) return
    for (const record of activities.values()) record.dirty = true
    armRefresh()
  }

  /**
   * Mark a finished card as one a newer card has replaced.
   *
   * The line goes on the card itself, and the card is not sent anywhere: it already exists, and a
   * reader who scrolled back is the only one who needs to know.
   * @param record - the finished record whose card is now the older one.
   */
  const markSuperseded = (record) => {
    record.superseded = true
    record.dirty = true
    armRefresh()
  }

  /** Keep the clock moving while nothing else changes. */
  const startClock = () => {
    if (clockTimer !== undefined) return
    clockTimer = setInterval(() => {
      if (disposed) return
      if ([...activities.values()].some(record => record.handle !== undefined && !record.settled)) touch()
    }, CLOCK_MS)
    clockTimer.unref?.()
  }

  /**
   * Follow one session event.
   * @param session - the session, as the firehose reports it.
   * @param event - the committed event.
   */
  const observe = (session, event) => {
    if (disposed || session?.id === undefined) return
    const type = event?.type

    if (type === 'turn/start') {
      // Recorded whatever the side is. A turn that starts while the desk has the person is
      // tracked without a card, so that taking the phone over mid-turn continues *that* run
      // instead of opening a second card for it — the record is what the card is, and two
      // records for one turn would mean two messages about one thing.
      const record = recordOf(session.id)
      // Whatever card this session already has is now the record of a finished run: a newer one
      // is about to exist, so it says so rather than looking like the live one.
      if (record.settled && record.handle !== undefined) markSuperseded(record)
      record.turn = event.data?.turn
      record.step = undefined
      record.tool = undefined
      record.fragments = []
      record.process = []
      record.failed = undefined
      record.settled = false
      record.superseded = false
      record.startedAt = now()
      if (record.workspace === undefined) record.workspace = workspaceOf(session.id)
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }

    const record = activities.get(session.id)
    if (record === undefined) return

    if (type === 'step/start') {
      record.turn = event.data?.turn ?? record.turn
      record.step = event.data?.step
      record.tool = undefined
      record.fragments = []
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }
    if (type === 'tool/call') {
      record.tool = event.data?.name
      record.step = event.data?.step ?? record.step
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }
    if (type === 'tool/result') {
      record.tool = undefined
      // Only a failed tool earns a line in the record: what a run did is mostly its text, and a
      // log of every successful call would bury the part a reader actually needs.
      const failure = event.data?.error
      const failed = event.data?.message?.content?.[0]?.isError === true || failure !== undefined
      if (failed) {
        const name = event.data?.name ?? event.data?.message?.content?.[0]?.toolCallId ?? ''
        note(record, messages().activityToolFailed(name, failure?.message ?? failure?.name ?? ''))
      }
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }
    if (type === 'user/message') {
      // What the person asked for belongs at the top of the record: it is the thing the rest of
      // it is an answer to.
      if (event.data?.source?.kind === 'user') {
        note(record, (event.data?.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join(''))
      }
      return
    }
    if (type === 'assistant/message') {
      if (event.data?.interrupted === true) record.failed = messages().activityInterrupted
      const text = (event.data?.message?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      // Every committed message goes into the record, whether or not it also called a tool: the
      // record is what the run said, and the reason to open it is to read that.
      note(record, text)
      // Only as a fallback: a deployment whose live frames never arrive still gets a card that
      // says something. With frames arriving, they are the newer and truer text.
      if (record.fragments.length === 0 && text !== '') {
        record.fragments = [text]
        record.dirty = true
        if (phoneHasIt()) armRefresh()
      }
      return
    }
    if (type === 'turn/end') {
      const reason = event.data?.reason
      record.settled = true
      // The tool line belongs to a run in progress; once the turn is over it is stale news,
      // and leaving it would have the card claim to be waiting on something that finished.
      record.tool = undefined
      if (reason?.kind === 'error') record.failed = reason.error?.message ?? messages().activityError
      // A turn cut off by its output ceiling did not finish, and saying only "stopped" would make
      // it look like one that did. It is the one end reason where the reader has a decision to
      // make — continue, or leave it — so the card says so.
      if (reason?.kind === 'max-tokens') record.failed = messages().activityTruncated
      // The card face shows the newest fragments, so a run whose text arrived only as live frames
      // would freeze with a record that never saw it. Closing on it is what the frozen card's
      // folded process is for, and it costs nothing when the committed message already noted it.
      const shown = record.fragments.join('')
      if (shown !== '' && !record.process.some(entry => entry.includes(shown.slice(0, 40)))) {
        note(record, shown)
      }
      record.dirty = true
      if (phoneHasIt()) armRefresh()
    }
  }

  /**
   * Follow one live stream frame.
   *
   * A delta is the smallest thing the model produces and there are hundreds of them, so the
   * card keeps the newest few and the edit behind them is throttled. That pairing is what makes
   * following every delta survivable on a channel that allows five edits a second.
   * @param session - the session the attempt belongs to.
   * @param frame - the start, chunk or end publication.
   */
  const observeStream = (session, frame) => {
    if (disposed || session === undefined || frame === undefined) return
    const record = activities.get(session)
    if (record === undefined || record.settled) return
    if (frame.type === 'start') {
      record.fragments = []
      record.tool = undefined
      record.turn = frame.turn ?? record.turn
      record.step = frame.step ?? record.step
      touch()
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type !== 'text-delta') return
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text === '') return
    record.fragments.push(text)
    if (record.fragments.length > RECENT_FRAGMENTS) {
      record.fragments = record.fragments.slice(-RECENT_FRAGMENTS)
    }
    touch()
  }

  return {
    /**
     * Start following the session and stream feeds.
     * @returns the disposer removing the listeners.
     */
    install() {
      disposed = false
      const offSession = ctx.on('session/event', observe)
      // One argument, and it is the payload: an agent-scoped listener is called with
      // `{ agent, frame }`, not with the frame beside it. Reading it as two arguments leaves
      // `frame` undefined and the live stream silently dead — which is the failure this
      // comment exists to keep anyone from reintroducing.
      const offStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        observeStream(agent?.id, frame)
      })
      startClock()
      return () => {
        offSession()
        offStream()
        disposed = true
        clearTimeout(refreshTimer)
        clearInterval(clockTimer)
        refreshTimer = undefined
        clockTimer = undefined
        activities.clear()
      }
    },
    observe,
    observeStream,
    /**
     * React to the person moving between the desk and the phone.
     *
     * A card is minted the first time the phone holds the person, and an already-running
     * session is followed from that moment: the session's next event settles it in, and this
     * asks for the edit that puts the card on screen.
     */
    onPriority() {
      if (phoneHasIt()) touch()
    },
    /** How many sessions are being shown, for the suite and for diagnostics. */
    tracked: () => activities.size,
    /**
     * The sessions being shown, oldest first.
     *
     * The order is the one eviction uses, so a case can assert what would be forgotten next
     * rather than inferring it from which cards happen to stop moving.
     * @returns the session ids, least recently used first.
     */
    order: () => [...activities.keys()],
  }
}
