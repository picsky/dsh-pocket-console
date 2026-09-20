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

import { CARD_TEXT_BUDGET, clipTailToBytes, clipToBytes, looksLikeSizeRefusal } from './budget.js'
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
 * The panel is the only place a reader can see what a run did, so it is worth real room — but not
 * unbounded, and not more than the card can carry: the fold competes with the card face for one
 * message, so the record is held to half of what the card's text is allowed. A run of a hundred
 * steps would otherwise put a document into one message, and a card the platform refuses says
 * nothing at all.
 */
const PROCESS_BUDGET = Math.floor(CARD_TEXT_BUDGET / 2)

/**
 * How much of one step's live stream is kept for the folded record.
 *
 * The same bound as the record itself, because that is what the text is for: it is folded into the
 * record when the step ends, and a step that streamed more than the record can hold would have its
 * excess clipped away in a moment anyway. Keeping it until then would mean a long step holding an
 * entire answer in memory to produce the same fold.
 */
const STREAM_BUDGET = PROCESS_BUDGET

/**
 * The bytes one string costs in memory, which is not the same question as what it costs to send.
 *
 * These totals exist only to bound what this process holds, so they are counted in the string's own
 * UTF-8 bytes; the budget the card is clipped to is a different number about a different thing
 * ({@link bodyBytes} in `budget.js`). Conflating the two would either over-count memory or
 * under-count the request.
 * @param value - the string to measure.
 * @returns its size in memory.
 */
const rawBytes = (value) => Buffer.byteLength(String(value ?? ''), 'utf8')

/**
 * How many finished turns one card's folded record keeps.
 *
 * A card lives as long as its session does, so the record would grow without end. The newest turns
 * are the ones a reader is looking for, and the oldest are the ones they have already read.
 */
const TURN_HISTORY = 5

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
      /**
       * What {@link process} currently costs, in the bytes its entries will be counted in.
       *
       * Kept rather than recomputed so that appending is not proportional to how long the run has
       * been going. It has to start at zero: left undefined, the first addition makes it `NaN`,
       * every comparison against the budget is then false, and the record grows without a bound.
       */
      processSize: 0,
      /**
       * Each finished turn's record, oldest first.
       *
       * The card is a session's one message, so what a reader scrolls back to is the sequence of
       * turns it has shown. `process` is the turn being followed now; this is what earlier ones
       * left behind, and it is the only copy there is.
       */
      turns: [],
      workspace: undefined,
      turn: undefined,
      step: undefined,
      /** The tool being waited on, for the status line. */
      tool: undefined,
      /** The last tool called, because a tool result names no tool of its own. */
      lastTool: undefined,
      fragments: [],
      /**
       * Every visible delta of the step being streamed, in order.
       *
       * {@link fragments} is what the card face shows, and is deliberately only the newest few.
       * This is the whole of the step, kept because the fold is what a reader opens to find out
       * what the run actually said: a record holding only the newest fragments would be a record
       * with the run's beginning cut off, and the live frames are the only copy of that text until
       * the step settles.
       */
      streamed: [],
      /**
       * What {@link streamed} currently costs, in the bytes it will be counted in.
       *
       * The same running total {@link processSize} is, for the same reason: a delta must append in
       * constant time no matter how long the step has been streaming.
       */
      streamSize: 0,
      /**
       * The step whose live stream produced {@link fragments}, and the step whose committed message
       * was already folded into the record.
       *
       * The two together are what stops the record from carrying a step's text twice. Live frames
       * and the committed `assistant/message` describe the same text by different routes, and a
       * record with both is a record that says everything twice. Comparing the step numbers is
       * exact; comparing the text is not, which is what a prefix match got wrong.
       */
      streamedStep: undefined,
      committedStep: undefined,
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
   * The readable text of a content field, whatever shape it arrived in.
   *
   * A tool result's `content` is an array of blocks, not a string, so reading it as one would put
   * `[object Object]` on the card where the failure's reason belongs. A plain string is accepted
   * too, because the field crosses a serialization boundary and a single text block is the common
   * case — one that some producers flatten before it gets here.
   * @param content - the content blocks, a bare string, or nothing.
   * @returns the joined text, empty when there is none.
   */
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
  }

  /**
   * Add one thing the run did to the record the frozen card will carry.
   *
   * The record is kept as a list of whole entries and its size as a running total, so nothing here
   * is proportional to how long the run has been going: a hundred-step run adds a line in the same
   * time the first one did. When the record is full the oldest entries go first — the end of a run
   * is what a reader is looking for.
   *
   * What is kept of an over-long entry depends on what the entry *is*, which is why the end is a
   * choice rather than a constant. A message a person or the model wrote is read from the top, so
   * the head is kept. Text folded back in from the live stream is the run's own ending — it is
   * being kept precisely because the step was still going — so the tail is what matters, and
   * clipping its head would drop the part a reader came for.
   * @param record - the session's record.
   * @param line - one message's text, or one line about a failure.
   * @param keep - which end of an over-long entry survives.
   */
  const note = (record, line, keep = 'head') => {
    const text = String(line ?? '').trim()
    if (text === '') return
    // One entry is bounded on its own: a single enormous message would otherwise sit in memory at
    // full size and be carried into every card until the record was trimmed around it. The entry's
    // bound is the record's own, measured the way the card will be sent rather than the way it is
    // held, because what the entry is for is being rendered.
    const bounded = keep === 'tail'
      ? clipTailToBytes(text, messages().truncated, PROCESS_BUDGET)
      : clipToBytes(text, messages().truncated, PROCESS_BUDGET)
    record.process.push(bounded)
    // The running total, on the other hand, is about what this process holds.
    record.processSize += rawBytes(bounded)
    while (record.processSize > PROCESS_BUDGET && record.process.length > 1) {
      record.processSize -= rawBytes(record.process[0])
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
   * @param budget - the byte budget for this render, halved on a size refusal.
   * @returns the panel, or undefined when the card is live or has nothing to show.
   */
  const detailsFor = (record, copy, budget = CARD_TEXT_BUDGET) => {
    if (!record.settled) return undefined
    // This turn's record first, then what earlier turns left: a reader opening the fold is asking
    // what happened, and the newest answer is the one they mean.
    const turns = [...record.turns, record.process].filter(entries => entries.length > 0)
    if (turns.length === 0) return undefined
    return {
      title: copy.activityProcess,
      // Folded content gets the whole card's room: nothing else has to fit beside it, and the
      // reason to open it is to read what the run did. Clipped from the front, because the end of
      // a run is what a reader is looking for — the same reason the record drops old entries.
      blocks: [clipTailToBytes(
        turns.map(entries => entries.join('\n\n')).join('\n\n---\n\n'),
        copy.truncatedOlder,
        budget,
      )],
    }
  }

  /**
   * Add one live delta to the step's stream, keeping the newest of it.
   *
   * Deltas arrive one token at a time and number in the thousands, so the running total is kept
   * rather than recomputed: appending must not cost more as the step goes on. The oldest deltas are
   * dropped first, because the end of a step is what a reader is looking for.
   * @param record - the session's record.
   * @param text - one visible delta.
   */
  const stream = (record, text) => {
    record.streamed.push(text)
    record.streamSize += rawBytes(text)
    while (record.streamSize > STREAM_BUDGET && record.streamed.length > 1) {
      record.streamSize -= rawBytes(record.streamed[0])
      record.streamed.shift()
    }
  }

  /**
   * Close the running turn's record and keep it on the card.
   *
   * The card is one message for a whole session, and the sequence of turns is what a reader
   * scrolling back wants from it. Keeping only the newest turn's record would throw away the one
   * thing this card is a record *of* — so a finished turn is appended to what the card already
   * holds, and the fold is what makes room for it.
   * @param record - the session's record.
   */
  const closeTurn = (record) => {
    if (record.process.length > 0) {
      record.turns.push(record.process)
      if (record.turns.length > TURN_HISTORY) record.turns.shift()
    }
    record.process = []
    // The running total describes `process`, so it goes back to zero with it. Carried over, the
    // next turn would start already over budget and lose its first entries for no reason.
    record.processSize = 0
    record.streamed = []
    record.streamSize = 0
  }

  /**
   * Render one session's card.
   *
   * Built on demand rather than kept, because a delivery refused for size is retried with less
   * text: the renderer takes the budget so the retry is a smaller card and not the same one again.
   * @param record - the session's record.
   * @param budget - the byte budget for this render, halved on a size refusal.
   * @returns the channel-neutral view.
   */
  const buildView = (record, budget = CARD_TEXT_BUDGET) => {
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
      body.push(copy.activityFailed(clipToBytes(record.failed, copy.truncated, Math.min(600, budget))))
    }
    // The newest of the stream, not the whole of it: the card is for glancing at, and the turn's
    // actual answer is what the result notice is for.
    const text = record.fragments.join('')
    body.push(text === '' ? copy.activityNothingYet : clipToBytes(text, copy.truncated, budget))
    const details = detailsFor(record, copy, budget)
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

  /**
   * Write one version of a card, halving the text once if the platform refuses it for size.
   *
   * The budget is chosen to stay inside the platform's limit, but that limit is documented outside
   * this repository and the retry is what keeps a card arriving if the real ceiling is lower than
   * the documentation says. Halving happens once: a second refusal means the size was not the
   * problem, and repeating the identical attempt would be a loop.
   * @param record - the session's record.
   * @param write - how to write one view: a first send, or an edit of an existing message.
   * @returns the write's own result.
   */
  const writeCard = (record, write) => {
    const attempt = async (budget) => {
      try {
        return await write(buildView(record, budget))
      } catch (error) {
        if (budget !== CARD_TEXT_BUDGET || !looksLikeSizeRefusal(error)) throw error
        log.debug(messages().logCardTooLarge)
        return await write(buildView(record, Math.floor(CARD_TEXT_BUDGET / 2)))
      }
    }
    return attempt(CARD_TEXT_BUDGET)
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
      if (record.handle === undefined) {
        // A send the platform accepted but whose answer was lost is the one way this card could
        // become two messages — and two messages mean two notifications for one run. The key is
        // what stops it: a channel that can carry one keeps the platform from accepting the same
        // card twice, and a channel that cannot is kept from a second *attempt* only by the
        // answer itself, which is why a delivered id is never sent again.
        record.sending = true
        record.uuid ??= randomUUID()
        void writeCard(record, view => channel.deliver(view, { uuid: record.uuid }))
          .then((handle) => {
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
      void writeCard(record, view => channel.update(record.handle, view))
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
      // A turn that ended before this one left a record; it stays on the card. Nothing else holds
      // it, so dropping it here would destroy the very thing a frozen card is.
      if (record.settled) closeTurn(record)
      record.turn = event.data?.turn
      record.step = undefined
      record.tool = undefined
      record.fragments = []
      record.streamed = []
      record.streamSize = 0
      record.streamedStep = undefined
      record.committedStep = undefined
      record.failed = undefined
      record.settled = false
      record.startedAt = now()
      if (record.workspace === undefined) record.workspace = workspaceOf(session.id)
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }

    const record = activities.get(session.id)
    if (record === undefined) return

    // An event from a turn this card has already closed, or from one it has not opened yet. The
    // log is appended in order, so this is rare — but a turn boundary arrives twice (a cancel and
    // a close can both report it) and a handler that ran late would otherwise fold an old turn's
    // text into the new turn's record, where it reads as something this run just said.
    const turn = event.data?.turn
    if (typeof turn === 'number' && typeof record.turn === 'number' && turn !== record.turn) return

    // The turn is closed, and this card is the record it closed with. It stays that way: folding a
    // late event would rewrite a card a reader may already have read, and — worse — put text into
    // a record that presents itself as the finished run. `user/message` is the one exception,
    // because a queued prompt is not part of the turn that ended: it opens the next one, and it is
    // the answer the record exists to be read against.
    if (record.settled && type !== 'user/message') return

    if (type === 'step/start') {
      record.step = event.data?.step
      record.tool = undefined
      record.fragments = []
      record.streamed = []
      record.streamSize = 0
      // The live stream belongs to one step, and this is a new one: keeping the old mark would
      // make the new step's committed message look like text the frames already carried.
      record.streamedStep = undefined
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }
    if (type === 'tool/call') {
      record.tool = event.data?.name
      // Kept because a `tool/result` names no tool of its own: the call that produced it is the
      // only thing that knows which one failed.
      record.lastTool = event.data?.name
      record.step = event.data?.step ?? record.step
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }
    if (type === 'tool/result') {
      record.tool = undefined
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      // Only a result appended to the surface is this run's news. A result that replaced earlier
      // nodes is compaction restating what the record already holds, and folding it would put the
      // same failure on the card a second time.
      if (event.surfaceOp !== 'append') return
      // Only a failed tool earns a line in the record: what a run did is mostly its text, and a
      // log of every successful call would bury the part a reader actually needs.
      const block = event.data?.message?.content?.[0]
      const failure = event.data?.error
      const failed = block?.isError === true || failure !== undefined
      if (failed) {
        // Three places a reason can live, in the order they are worth reading. `error` carries a
        // kind and a code, not prose — the prose is in the result's own content — so a line that
        // stopped at `error.name` would tell a reader an error class and nothing they can act on.
        // The tool's name comes from the call: a result block names only the call id, so the
        // `tool/call` that preceded it is the only thing that knows which tool failed.
        const name = record.lastTool ?? ''
        const reason = [
          typeof failure?.reason === 'string' ? failure.reason : '',
          textOf(block?.content),
          [failure?.name, failure?.code].filter(Boolean).join(' '),
        ].find(candidate => candidate !== '') ?? ''
        note(record, messages().activityToolFailed(name, clipToBytes(reason, messages().truncated, 300)))
      }
      return
    }
    if (type === 'user/message') {
      // What the person asked for belongs at the top of the record: it is the thing the rest of
      // it is an answer to.
      if (event.data?.source?.kind === 'user') note(record, textOf(event.data?.content))
      return
    }
    if (type === 'assistant/message') {
      // Only a message appended to the surface is new text. Compaction rewrites earlier nodes with
      // `surfaceOp: { op: 'replace' }`, restating text the record already holds in place of the
      // nodes it shadows — folding that in would put the same words on the card twice.
      if (event.surfaceOp !== 'append') return
      const step = event.data?.step
      if (event.data?.interrupted === true) record.failed = messages().activityInterrupted
      const text = textOf(event.data?.message?.content)
      // Every committed message goes into the record, whether or not it also called a tool: the
      // record is what the run said, and the reason to open it is to read that.
      note(record, text)
      // Remembered so `turn/end` can tell that this step's text is already in the record. The live
      // frames carry the same words, and only one of the two routes may fold them.
      if (step !== undefined) record.committedStep = step
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
      // What is folded is the whole of the streamed step, not the card's tail. It is skipped when
      // the step's committed message was already folded, which is the ordinary case for a run whose
      // text both streamed and settled. Only a positive match of two *known* step numbers skips:
      // when either marker is missing — a deployment that streams without a step, or a message that
      // arrived without one — the text is kept, because dropping a run's own words is the worse of
      // the two mistakes.
      const shown = record.streamed.join('')
      const alreadyFolded = record.streamedStep !== undefined && record.streamedStep === record.committedStep
      if (shown !== '' && !alreadyFolded) note(record, shown, 'tail')
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
    stream(record, text)
    // Which step these frames belong to, taken from the `start` frame that opened this attempt:
    // a `chunk` frame carries no step of its own. This is the mark `turn/end` compares against to
    // tell whether the committed message is text the frames already carried.
    record.streamedStep = record.step
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
     * A card is minted the first time the phone holds the person. Touching alone was not enough: it
     * marks records that already exist, and a session running when the person moved had none — it
     * is created on the next session event, which for a run already in flight may be its last. So
     * the first thing a run did after the phone took over was the one thing the phone could not
     * show, which is precisely the run somebody picks the phone up to look at. Every session the
     * registry still reports as running is taken on here instead.
     */
    onPriority() {
      if (!phoneHasIt()) return
      let tookOn = false
      for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
        // `agent.session.id` is the session this agent drives, which is the key every record and
        // every event is filed under.
        const session = agent?.session?.id
        if (session === undefined || agent?.status !== 'running') continue
        // Whichever comes first: a session already followed keeps its card, and one that was not is
        // taken on now so the rest of its turn is recorded.
        if (!activities.has(session)) tookOn = true
        recordOf(session)
      }
      // Marked for writing, and the write scheduled *here* rather than left to `touch`: a refresh
      // already pending would make `armRefresh` a no-op, and this record was just created, so
      // nothing else is waiting to carry it to the phone.
      for (const record of activities.values()) record.dirty = true
      if (tookOn) armRefresh()
      else touch()
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
