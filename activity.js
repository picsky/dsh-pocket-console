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

/** Sessions shown at once before the coldest are forgotten. */
const CAPACITY = 64

/** How many of the newest deltas the card keeps. */
const RECENT_FRAGMENTS = 3

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
   * The map is bounded because a record is small but permanent otherwise: forgetting the
   * coldest is right, since a session nobody has run in that long is not about to be read.
   * @param session - the session id.
   * @returns its record.
   */
  const recordOf = (session) => {
    let record = activities.get(session)
    if (record === undefined) {
      if (activities.size >= CAPACITY) activities.delete(activities.keys().next().value)
      record = {
        session,
        handle: undefined,
        sending: false,
        dirty: false,
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
    }
    return record
  }

  /** The workspace one session belongs to, read once and carried like every other card. */
  const workspaceOf = (session) => workspaceLabel(ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd)

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
    if (record.settled) return copy.activityStopped
    if (record.tool !== undefined) return copy.activityWaiting
    return copy.activityRunning
  }

  /**
   * Render one session's card.
   * @param record - the session's record.
   * @returns the channel-neutral view.
   */
  const buildView = (record) => {
    const copy = messages()
    console.warn(`DEBUG buildView session=${String(record.session)} ws=${String(record.workspace)} handle=${String(record.handle)} settled=${record.settled}`)
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
    return {
      title: titleOf(`${settings().titlePrefix} ${copy.activityTitle}`, record.workspace),
      tone: record.failed !== undefined ? 'danger' : record.settled ? 'muted' : 'info',
      body,
      // Nothing to press: this card exists to be looked at, and a control on it could meet an
      // edit while it is being used.
      buttons: [],
      forms: [],
    }
  }

  /**
   * Write out every card whose contents moved.
   *
   * Sends the first version and edits every one after it: the send is the only notification
   * this card ever produces.
   */
  const flush = () => {
    refreshTimer = undefined
    if (disposed) return
    for (const record of activities.values()) {
      if (!record.dirty || record.sending) continue
      record.dirty = false
      const view = buildView(record)
      if (record.handle === undefined) {
        record.sending = true
        void Promise.resolve(channel.deliver(view)).then((handle) => {
          record.handle = handle
          record.sending = false
          // Remembered against the message as well, so a card rewritten without its record —
          // after a restart — can still name the session it belongs to.
          workspaces?.record(handle, record.workspace)
          log.info(messages().logActivitySent)
        }).catch((error) => {
          record.sending = false
          log.warn(messages().logActivitySendFailed, error)
        })
        continue
      }
      void Promise.resolve(channel.update(record.handle, view))
        .catch(error => { log.warn(messages().logActivityUpdateFailed, error) })
    }
  }

  /** Ask for an edit, at most once per refresh window. */
  const touch = () => {
    if (disposed) return
    for (const record of activities.values()) record.dirty = true
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(flush, REFRESH_MS)
    refreshTimer.unref?.()
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
      if (!phoneHasIt()) return
      // A new turn starts the card over: the reader wants where it is now, not where the last
      // turn got to.
      const record = recordOf(session.id)
      record.turn = event.data?.turn
      record.step = undefined
      record.tool = undefined
      record.fragments = []
      record.failed = undefined
      record.settled = false
      record.startedAt = now()
      if (record.workspace === undefined) record.workspace = workspaceOf(session.id)
      touch()
      return
    }

    const record = activities.get(session.id)
    if (record === undefined) return

    if (type === 'step/start') {
      record.turn = event.data?.turn ?? record.turn
      record.step = event.data?.step
      record.tool = undefined
      record.fragments = []
      touch()
      return
    }
    if (type === 'tool/call') {
      record.tool = event.data?.name
      record.step = event.data?.step ?? record.step
      touch()
      return
    }
    if (type === 'tool/result') {
      record.tool = undefined
      touch()
      return
    }
    if (type === 'assistant/message') {
      if (event.data?.interrupted === true) record.failed = messages().activityInterrupted
      // Only as a fallback: a deployment whose live frames never arrive still gets a card that
      // says something. With frames arriving, they are the newer and truer text.
      if (record.fragments.length === 0) {
        const text = (event.data?.message?.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (text !== '') {
          record.fragments = [text]
          touch()
        }
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
      touch()
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
      const offStream = ctx.on('agent/assistant-stream', (payload, frame) => {
        observeStream(payload?.agent?.id, frame)
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
  }
}
