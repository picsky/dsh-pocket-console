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

/**
 * How many times one write to this card is attempted before it is given up on.
 *
 * A retry is safe because the send carries an idempotency key, but safe is not the same as finite:
 * a channel that is down for an hour would otherwise be retried every {@link RETRY_MS} for the life
 * of the process, one warning per tick, describing a run that finished long ago. Four attempts span
 * roughly a minute — long enough for a reconnect or a restart of the return path, short enough that a
 * deployment which stays broken is not a machine that never stops trying.
 *
 * Giving up is a real loss and is logged as one: a card whose run has already ended is never written
 * again, so a reader looking at it sees whatever it said last. That is the honest outcome — a card
 * that cannot be sent cannot be read either — and it is strictly better than an unbounded loop.
 */
const MAX_TRIES = 4

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
 * **One, and that is the whole of the number.** The fold answers "what did the sentence I just sent
 * do" — and the card it is on *is* the card the person answered (see
 * `docs/decisions/0021-the-card-you-pressed-is-the-one-that-moves.md`). A running history of the
 * session would show the reader work they have already read on the result cards of earlier turns,
 * and bury the one thing they opened it for.
 *
 * The single turn kept is the one the reply was made against, and keeping it is not sentiment: the
 * card face becomes the run, so without that turn the answer the reader was reading at the moment
 * they answered it would be gone from the phone entirely.
 */
const TURN_HISTORY = 1

/**
 * Create the activity card.
 * @param options - the logger, the channel, the settings, copy, priority, and the workspace
 *   registry every delivered card is remembered in.
 * @returns installation, the event feed, and what a priority change does to the card.
 */
export function createActivity({
  ctx, log, channel, settings, messages, priority, workspaces, diagnostics = () => {},
  now = () => Date.now(),
}) {
  /** One record per session being shown: what it is doing, and the message its card lives in. */
  const activities = new Map()
  /** Set while an edit is scheduled, so a run of deltas collapses into one. */
  let refreshTimer
  /** Set while the slow clock tick is scheduled. */
  let clockTimer
  /** Set once the module is disposed, so a pending edit does not outlive it. */
  let disposed = false

  /** The side the person is on, which is the only condition that mints a card. */
  const phoneHasIt = () => priority?.get() === PHONE

  /**
   * Say that a run is being left alone because the desk has the person, once per stretch of that.
   *
   * The refresh loop this sits in runs every quarter second, so the same decision arrives over and
   * over; what a reader wants is the moment the decision changed, not a count of how often it was
   * re-taken. The first release of this line wrote unconditionally and produced hundreds of
   * identical lines for one run — which hid the evidence it was added to find.
   * @param record - the card being left alone.
   * @param line - what to say the first time.
   */
  const noteSkip = (record, line) => {
    if (record.saidSkip === true) return
    record.saidSkip = true
    diagnostics?.(line)
  }

  /** Forget that a skip was reported, so the next one says so again. */
  const clearSkip = (record) => { record.saidSkip = false }

  /**
   * Messages whose card outlived the record that owned it, keyed by session.
   *
   * Bounded like everything else here, and for the same reason: a session evicted from
   * {@link activities} is one nobody has run for a while, so a handle for it is worth holding only
   * long enough for the session to come back. An entry that is never claimed ages out with the
   * coldest-first rule.
   */
  const orphaned = new Map()

  /** Remember which message a session's card is, so a re-taken session edits it instead of resending. */
  const rememberHandle = (session, handle) => {
    if (orphaned.size >= CAPACITY) orphaned.delete(orphaned.keys().next().value)
    orphaned.set(session, handle)
  }

  /** Take back the message a session's card is, if one was remembered. */
  const claimedHandle = (session) => {
    const handle = orphaned.get(session)
    if (handle !== undefined) orphaned.delete(session)
    return handle
  }

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
    //
    // The place that has to be given up may be one whose card is already on the phone, and dropping
    // the record would drop the only thing that knows which message that card is: the session's next
    // event would find no handle and **send a second card for one run**, which is a notification this
    // plugin promised not to produce. So the message is kept beside the map rather than inside the
    // record — a handle is a short string, and remembering it is what makes the card's life outlast
    // the record's.
    if (activities.size >= CAPACITY) {
      const evicted = activities.keys().next().value
      const going = activities.get(evicted)
      if (going?.handle !== undefined) rememberHandle(evicted, going.handle)
      activities.delete(evicted)
    }
    const record = {
      session,
      handle: claimedHandle(session),
      sending: false,
      dirty: false,
      /** When a failed send may be tried again, so a dead channel is not hammered. */
      retryAt: undefined,
      /**
       * How many times the write now owed to this card has failed.
       *
       * One counter for the card rather than one per kind of write: a send that fails becomes the
       * edit that follows it, and a reader does not care which half of the write gave up. Reset
       * whenever a write lands, so a card that recovers has its full budget again.
       */
      attempts: 0,
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
   * One entry as the card shows it.
   *
   * The only thing marked is a person's own words, and that is deliberate: everything else in the
   * fold is the run talking about itself, and marking all of it would leave nothing marked. A reader
   * opening the fold is looking for the sentence they sent — the anchor the rest of it answers — and
   * in a wall of model prose that sentence is otherwise the hardest thing on the card to find.
   * @param entry - one recorded entry.
   * @param copy - the copy table in force.
   * @returns the text the card renders for it.
   */
  const renderEntry = (entry, copy) => (entry.kind === 'human' ? copy.humanLine(entry.text) : entry.text)

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
   * @param kind - whose line it is: `human`, `model`, or `tool`. Kept per entry because the fold
   *   marks a person's own words and nothing else, and a bare string cannot say which it was.
   * @param keep - which end of an over-long entry survives.
   */
  const note = (record, line, kind = 'model', keep = 'head') => {
    const copy = messages()
    const text = String(line ?? '').trim()
    if (text === '') return
    // One entry is bounded on its own: a single enormous message would otherwise sit in memory at
    // full size and be carried into every card until the record was trimmed around it. The entry's
    // bound is the record's own, measured the way the card will be sent rather than the way it is
    // held, because what the entry is for is being rendered.
    const bounded = keep === 'tail'
      ? clipTailToBytes(text, copy.truncated, PROCESS_BUDGET)
      : clipToBytes(text, copy.truncated, PROCESS_BUDGET)
    const entry = { text: bounded, kind }
    record.process.push(entry)
    // The running total is about what this process holds **as it will be rendered**: the marker a
    // human line carries is part of what the card costs, and a total that left it out would let a
    // record of nothing but human lines sit over the budget it is trimmed against.
    record.processSize += rawBytes(renderEntry(entry, copy))
    while (record.processSize > PROCESS_BUDGET && record.process.length > 1) {
      record.processSize -= rawBytes(renderEntry(record.process[0], copy))
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
    // The group being collected, after the one it followed: a reader opening the fold is asking what
    // the sentence they sent did, and the group before it is there only because the card face no
    // longer carries the answer they were reading when they sent it. One boundary, one extra group —
    // see {@link TURN_HISTORY} for why there is no more history than that.
    const turns = [...record.turns, record.process].filter(entries => entries.length > 0)
    if (turns.length === 0) return undefined
    return {
      title: copy.activityProcess,
      // Folded content gets the whole card's room: nothing else has to fit beside it, and the
      // reason to open it is to read what the run did. Clipped from the front, because the end of
      // a run is what a reader is looking for — the same reason the record drops old entries.
      blocks: [clipTailToBytes(
        turns
          .map(entries => entries.map(entry => renderEntry(entry, copy)).join('\n\n'))
          .join('\n\n---\n\n'),
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
   * File the group of entries being collected as a finished one.
   *
   * A group is one stretch between two moments a person spoke. It is filed when the next one starts
   * — which is the person speaking, or a turn opening with nobody having spoken in between.
   *
   * Deliberately **not** the whole of {@link resetFace}: a person can speak while a step is still
   * streaming, and that splits the record without ending the step. Clearing the stream buffers there
   * would drop the text of a step that is still going, which is the text the fold exists to end with.
   * @param record - the session's record.
   */
  const archiveProcess = (record) => {
    if (record.process.length === 0) return
    record.turns.push(record.process)
    if (record.turns.length > TURN_HISTORY) record.turns.shift()
    record.process = []
    // The running total describes `process`, so it goes back to zero with it. Carried over, the
    // next turn would start already over budget and lose its first entries for no reason.
    record.processSize = 0
  }

  /**
   * Start a fresh turn on this record: nothing of the finished one is left on the card face.
   *
   * Called when a person speaks and when a reply is adopted, both of which are followed by a
   * `turn/start` milliseconds later. Doing the reset here rather than waiting for that event is what
   * keeps the card from showing the previous turn's step number, its last fragments of text and its
   * elapsed clock under a heading that says the new instruction is running.
   * @param record - the session's record.
   */
  const resetFace = (record) => {
    record.turn = undefined
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
  }

  /** File the finished group and start a fresh turn on what is left. */
  const openGroup = (record) => {
    archiveProcess(record)
    resetFace(record)
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
   * Note that a write to one card failed, and say whether another attempt is owed.
   *
   * A failure during retry backoff is not requeued: the retry is already scheduled, and holding the
   * refresh open for it would spin the timer instead of waiting. A send that is merely *in flight*
   * is requeued, because that one has no future write scheduled and whatever changed meanwhile would
   * otherwise never be written.
   *
   * @param record - the card whose write failed.
   * @param error - what the channel raised.
   * @param copy - the message copy, for the line that names the kind of write.
   * @returns whether the flush should come back for this record.
   */
  /**
   * Note that a write to one card failed, and schedule the next attempt.
   *
   * A failure during retry backoff is not requeued in the flush: the retry is already scheduled, and
   * holding the refresh open for it would spin the timer instead of waiting. A send that is merely
   * *in flight* is requeued, because that one has no future write scheduled and whatever changed
   * meanwhile would otherwise never be written.
   *
   * @param record - the card whose write failed.
   * @param error - what the channel raised.
   * @param copy - the message copy, for the line that names the kind of write.
   */
  const noteFailure = (record, error, copy) => {
    record.attempts += 1
    if (record.attempts >= MAX_TRIES) {
      // Given up on, and said out loud. The card keeps whatever it last showed — for a run that has
      // already ended, that means it can read as unfinished — so the log has to be the place a
      // deployment learns that this message stopped being maintained. Silence here is what would
      // turn "the channel was down for a while" into "the plugin quietly stopped working".
      record.dirty = false
      record.retryAt = undefined
      log.warn(messages().logActivityGivenUp(record.attempts, record.session), error)
      return
    }
    record.retryAt = now() + RETRY_MS
    record.dirty = true
    log.warn(copy, error)
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
      // Held back while a send is in flight, and while a send that failed is waiting its turn — and
      // **both** keep the flush coming back, which is not an optimisation to drop. A retry has no
      // timer of its own: the requeue below is the only thing that brings the flush back after a
      // failure, so removing it for the waiting case leaves a card whose send failed with nothing
      // left to try it again. (An earlier version of this line did exactly that, and the only sign
      // was an existing case timing out: no second attempt, and no error to say why.)
      if (record.sending || (record.retryAt ?? 0) > at) {
        requeue = true
        continue
      }
      if (!phoneHasIt()) {
        // The desk has the person. A card that exists keeps its last state — it is a record of
        // a run, and taking it away would take away the answer to "what was it doing" — and one
        // that was never sent is not sent now, because a message the desk is not expecting is
        // exactly the notification this plugin does not send.
        //
        // Said once per stretch, not once per refresh. This sits in a loop that runs every quarter
        // second while a run streams, so a line written unconditionally here is written hundreds of
        // times for one decision — and a diagnostic that floods the file it writes to is worse than
        // no diagnostic: the first release of this line buried the very reply-path evidence it was
        // added to find, and the log looked like it was working.
        noteSkip(record, `活动卡：跳过「${record.session}」——桌面持有优先侧，这一轮不发卡。`)
        record.dirty = false
        continue
      }
      clearSkip(record)
      record.dirty = false
      if (record.handle === undefined) {
        // A send the platform accepted but whose answer was lost is the one way this card could
        // become two messages — and two messages mean two notifications for one run. The key is
        // what stops it: a channel that can carry one keeps the platform from accepting the same
        // card twice, and a channel that cannot is kept from a second *attempt* only by the
        // answer itself, which is why a delivered id is never sent again.
        diagnostics?.(`活动卡：为「${record.session}」创建——这一轮会响。`)
        record.sending = true
        record.uuid ??= randomUUID()
        void writeCard(record, view => channel.deliver(view, { uuid: record.uuid }))
          .then((handle) => {
            record.handle = handle
            record.sending = false
            record.retryAt = undefined
            record.attempts = 0
            // Remembered against the message as well, so a card rewritten without its record —
            // after a restart — can still name the session it belongs to.
            workspaces?.record(handle, record.workspace)
            log.info(messages().logActivitySent)
            diagnostics?.(`活动卡：「${record.session}」的卡是消息 ${String(handle)}。`)
          }).catch((error) => {
            record.sending = false
            // An answer that never arrived is the one failure worth retrying: the card may or may
            // not exist, and the key is what makes trying again safe. A channel that is down is
            // waited out rather than hammered at the refresh rate — and given up on eventually.
            noteFailure(record, error, messages().logActivitySendFailed)
          })
        continue
      }
      // A failed edit has to be retried, and this is the only place that can do it: the clock that
      // re-marks a live card dirty stops touching a settled one, so a final write that failed used
      // to leave the card saying "working" for good — the last state of a run nobody could correct.
      //
      // Whether this is a reuse or a brand-new message is the whole question behind "the card did
      // not change", and it is not answerable from outside: an edit and a send look the same on the
      // phone. Said here, once per write, because this is the only place that knows.
      diagnostics?.(`活动卡：改写「${record.session}」的消息 ${String(record.handle)}（复用，不响）。`)
      void writeCard(record, view => channel.update(record.handle, view))
        .then(() => {
          record.attempts = 0
          record.retryAt = undefined
        })
        .catch(error => { noteFailure(record, error, messages().logActivityUpdateFailed) })
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
   * Take a message somebody else sent and make it this session's card.
   *
   * This is what turns the card a person just answered into the card their answer runs on. Without
   * it the run that a reply starts is shown on *another* message — the one this module minted when
   * the session was first taken on — and the card the person is looking at, the one they pressed,
   * says "已收到" and nothing else. Two messages for one press, and the one that moves is not the one
   * they touched.
   *
   * The turn state is reset here, and not left to the `turn/start` that is about to arrive, because
   * the write is armed below: the card has to be right from its first write, and an event that
   * arrives after it would otherwise leave the reader looking at the previous turn's step number and
   * its last few fragments of text under a heading that says the new instruction is running.
   *
   * Refused while a send is in flight. The answer to that send is the handle this record is waiting
   * for, and it would land on top of the one just adopted — so the reply path keeps its own rewrite
   * instead, which is the honest card for a session whose first card is still being created.
   *
   * @param session - the session whose card this is.
   * @param handle - the message to take over, as the channel named it.
   * @returns whether the card was taken over.
   */
  const adopt = (session, handle) => {
    if (disposed || session === undefined || handle === undefined) return false
    // The precondition {@link flush} writes under, checked rather than assumed: this module maintains
    // a card **only** while the phone holds the person, and taking a message over outside that would
    // leave a reader's reply sitting on a card this side quietly owns and never writes again — worse
    // than the "已收到" rewrite it replaced, because that one at least lands. The reply path itself
    // satisfies this (the reader is at the phone, and `send` moves the side before calling), so what
    // this line is for is the next caller that has not thought about it.
    if (!phoneHasIt()) return false
    const known = activities.get(session)
    if (known?.sending === true) return false
    const record = recordOf(session)
    // A settled record is about to describe a new turn, and the finished one is filed as the group
    // the fold keeps — but only a settled one. A record still mid-turn is already describing a run
    // in progress, and that is the truth to show.
    if (record.settled) openGroup(record)
    record.handle = handle
    // The key belonged to a message that was never sent, and this one already exists: kept, it would
    // be presented as the identity of a send that is not going to happen.
    record.uuid = undefined
    record.attempts = 0
    record.retryAt = undefined
    if (record.workspace === undefined) record.workspace = workspaceOf(session)
    // Whether this record can carry the fold the card being taken over had. That fold came from the
    // run record; this one is built from what *this* module followed, so nothing tracked means the
    // answer and the run it belongs to leave the phone with the card face. It happens when the
    // process started mid-turn, or when this session's record was evicted. Said out loud, because
    // from the phone the result looks like any other run — a card whose fold simply holds less.
    if (record.turns.length === 0 && record.process.length === 0) {
      diagnostics?.(`活动卡：接过消息 ${String(handle)} 时没有「${session}」这一轮的记录——那张卡上的折叠接不过来。`)
    }
    record.dirty = true
    diagnostics?.(`活动卡：接过消息 ${String(handle)} 作为「${session}」的卡——不再另发一张。`)
    armRefresh()
    return true
  }

  /**
   * Whether a message is the card some session is being shown in.
   *
   * Asked by the result notifier before it rewrites a press that has nothing to answer, because the
   * card a reply was made on *is* the run's card from that moment on: a stale press that wrote
   * "此卡已失效" over it would replace the live run with a sentence about a notice that is gone.
   * @param handle - the message to ask about.
   * @returns whether this module is showing a session in it.
   */
  const owns = (handle) => {
    if (handle === undefined) return false
    for (const record of activities.values()) {
      if (record.handle === handle) return true
    }
    return false
  }

  /**
   * Re-mark the cards the clock is still responsible for.
   *
   * Three kinds are owed a write, and all three have to be named or the one that is left out becomes
   * a card frozen in a state it is no longer in:
   *
   * - a live card, whose elapsed time is the thing that keeps answering "is it still going";
   * - a card whose write failed, while it still has an attempt left — including a **settled** one,
   *   because a finished run's last state is the whole of what a reader scrolls back to;
   * - nothing else. A card that has been given up on is not touched, which is what keeps the retry
   *   budget finite.
   */
  const startClock = () => {
    if (clockTimer !== undefined) return
    clockTimer = setInterval(() => {
      if (disposed) return
      let owed = false
      for (const record of activities.values()) {
        if (record.handle === undefined) continue
        // A live card keeps its clock moving. A settled one is re-marked only while it still owes a
        // write that failed — which is the case that used to be dropped on the floor, because the
        // clock's own test excluded every settled card and nothing else ever asked for that write.
        const live = !record.settled
        const retrying = record.retryAt !== undefined && record.attempts < MAX_TRIES
        if (!live && !retrying) continue
        record.dirty = true
        owed = true
      }
      if (owed) armRefresh()
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
      // A turn that ended before this one left a record: its entries are filed as a group. Filing —
      // not the whole face reset — because a turn can also open with nobody having spoken in between
      // (a retry, a queued continuation), and that group has to be closed too or the two turns read
      // as one.
      if (record.settled) archiveProcess(record)
      resetFace(record)
      record.turn = event.data?.turn
      if (record.workspace === undefined) record.workspace = workspaceOf(session.id)
      record.dirty = true
      if (phoneHasIt()) armRefresh()
      return
    }

    // A person's own message builds the record if nothing has yet, because that sentence is the
    // anchor of everything the card will show and the `turn/start` that follows cannot restore it.
    // Only while the phone holds the person: a record exists to feed a card, and building one for
    // every desk session would push live ones out of a map that is bounded on purpose.
    const record = activities.get(session.id)
      ?? (type === 'user/message' && event.data?.source?.kind === 'user' && phoneHasIt()
        ? recordOf(session.id)
        : undefined)
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
        note(record, messages().activityToolFailed(name, clipToBytes(reason, messages().truncated, 300)), 'tool')
      }
      return
    }
    if (type === 'user/message') {
      // A person speaking is the boundary, and the `turn/start` that opens the turn arrives *after*
      // this event: with the boundary drawn at that event instead, their sentence was appended to the
      // group that was still open — the work they are *not* talking about — and the `---` between the
      // two groups landed one message too late.
      const opened = record.settled
      archiveProcess(record)
      // The face only starts over when the previous turn had ended. A person can also speak while a
      // step is still streaming, and that splits the record without ending the step.
      if (opened) resetFace(record)
      // What the person asked for belongs at the top of the group: it is the thing the rest of it is
      // an answer to, and the fold marks it so a reader can find it without reading the whole run.
      if (event.data?.source?.kind === 'user') note(record, textOf(event.data?.content), 'human')
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
      if (shown !== '' && !alreadyFolded) note(record, shown, 'model', 'tail')
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
     * Make an already-delivered message this session's card.
     *
     * Called by the result notifier when a reply is accepted: the card the reply was typed on is the
     * one the person is looking at, so the run their instruction starts belongs there rather than on
     * a message of this module's own.
     * @param session - the session the card belongs to.
     * @param handle - the message to take over.
     * @returns whether the card was taken over.
     */
    adopt,
    /**
     * Whether a message is the card this module is showing a session in.
     * @param handle - the message to ask about.
     * @returns whether some session is shown in it.
     */
    owns,
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
