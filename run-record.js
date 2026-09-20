/**
 * What one run of a session did, kept from the last thing a person said until the turn stops.
 *
 * The result card used to carry only the model's **last** message, and that is not enough to act on.
 * A turn that produces a plan and then a few confirmations ends with a confirmation, so the phone
 * shows "done" while the thing being confirmed — the plan — is nowhere on it. The person is left
 * deciding the next step without the text that step depends on.
 *
 * So the unit here is not "the last message" but **one run**: everything from the last human message
 * to the moment the turn ends. That has three consequences worth stating, because each one is
 * load-bearing:
 *
 * - **The anchor is a human message.** When somebody speaks, what came before is no longer what they
 *   are asking about, so the run starts again there. This is also what bounds the store without an
 *   arbitrary cap: the text before the anchor is dropped because nothing will ask for it.
 * - **It is kept per session, whether or not a card was ever sent for it.** The activity card only
 *   exists while the phone holds the person, so a run that happened at the desk had no record at all
 *   — and neither did the first run after the phone took over, which is exactly when somebody looks.
 * - **The same policy as everywhere else decides what goes in**: what a person said, what the model
 *   said, and the tools that failed. Successful tool calls are dropped, because their output does not
 *   change what the reader writes next.
 *
 * What is kept is bounded, and what a bound drops is counted rather than silently lost: a result card
 * that had to leave something out has to be able to say so, or a reader cannot tell a short run from
 * a truncated one.
 *
 * @module pocket-console/run-record
 */

import { clipTailToBytes, clipToBytes } from './budget.js'

/**
 * How much of one run is kept.
 *
 * The largest thing this store holds, and it holds it per live session, so it is deliberately not
 * generous. What it has to fit is the shape the feature exists for — a plan and the confirmations
 * after it — and a run that says more than this is a run whose middle a phone could not have shown
 * anyway.
 */
export const RUN_BUDGET = 8 * 1024

/** Sessions remembered before the coldest is forgotten. */
const CAPACITY = 64

/** Finished turns one session keeps, so a frozen card still has the sequence it always had. */
const TURN_HISTORY = 5

/**
 * What kind of step each tool name is, copied from the Harness's own client
 * (`@deepseek-ai/dsh-client-ui-tool`'s `TOOL_VARIANTS`).
 *
 * Taken from there rather than invented here, so a phone and the desk agree on what a tool is, and
 * kept to six kinds because the phone question is "how far along is this", which six answers. A tool
 * this table does not know — one an installed plugin provides — is deliberately **not** guessed at:
 * it falls back to a generic line, because a wrong kind is worse than an unspecific one.
 */
const TOOL_KINDS = {
  bash: 'command',
  pwsh: 'command',
  read: 'read',
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
}

/**
 * The bytes one string costs in memory, which is not what it costs to send.
 *
 * These totals exist to bound what this process holds, so they are counted in the string's own UTF-8
 * bytes. The budget a card is clipped to is a different number about a different thing
 * ({@link bodyBytes} in `budget.js`).
 * @param value - the string to measure.
 * @returns its size in memory.
 */
const rawBytes = (value) => Buffer.byteLength(String(value ?? ''), 'utf8')

/**
 * The readable text of a content field, whatever shape it arrived in.
 *
 * A tool result's `content` is an array of blocks, not a string, so reading it as one would put
 * `[object Object]` on the card where the failure's reason belongs.
 * @param content - the content blocks, a bare string, or nothing.
 * @returns the joined text, empty when there is none.
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Create the record.
 * @param options - the copy table, so a truncated entry says so in the deployment's language.
 * @returns feeding it session events, and reading one run back.
 */
export function createRunRecord({ messages }) {
  /** One entry per session: the turns it has finished, and the one being followed now. */
  const records = new Map()

  /**
   * One session's record, created on first sight.
   *
   * Bounded by least-recently-used rather than by creation: a session that started long ago and is
   * running right now must not be evicted out from under the run it is recording.
   * @param session - the session id.
   * @returns its record.
   */
  const recordOf = (session) => {
    const known = records.get(session)
    if (known !== undefined) {
      // Only moved while there is room: at the cap, re-inserting a key that is already last would
      // remove it and then find nowhere to put it back, losing the record for good.
      if (records.size < CAPACITY) {
        records.delete(session)
        records.set(session, known)
      }
      return known
    }
    if (records.size >= CAPACITY) records.delete(records.keys().next().value)
    const record = {
      session,
      /** The run being followed now: what a person said, what the model said, what failed. */
      process: [],
      /** What {@link process} currently costs, so appending stays constant-time. */
      processSize: 0,
      /** Finished runs, oldest first, so a frozen card keeps the sequence it always had. */
      turns: [],
      /**
       * How many entries the bound has dropped from the run being followed.
       *
       * Kept apart from `dropped`, which spans everything the record has lost: a result card shows
       * one run and has to describe that run's loss, while a frozen card shows the whole fold and
       * has to describe the fold's.
       */
      runEntriesLost: 0,
      /** The visible deltas of the step being streamed, which are the only copy until it settles. */
      streamed: [],
      /** What {@link streamed} currently costs. */
      streamSize: 0,
      /** The step those frames belong to, and the step whose message was already folded. */
      streamedStep: undefined,
      committedStep: undefined,
      /** The last tool named, because a tool result names no tool of its own. */
      lastTool: undefined,
      /**
       * The kind of the tool line most recently appended, and how many calls it now stands for.
       *
       * A run of the same kind collapses into one line with a count: twenty reads and one read say
       * the same thing to a reader deciding what to do next, and the nineteenth line of `读取` only
       * costs the budget the prose needs.
       */
      lastKind: undefined,
      lastKindCount: 0,
      /**
       * What the bound has made this record leave out, in bytes.
       *
       * Counted rather than merely lost: a card that dropped part of a run has to be able to say so,
       * and a reader who is not told cannot tell a short run from a truncated one. Never reset, for
       * the same reason — a fold reporting only its newest run's losses would under-report what a
       * reader is missing.
       */
      dropped: 0,
    }
    records.set(session, record)
    return record
  }

  /**
   * Add one thing the run did.
   *
   * What is kept of an over-long entry depends on what the entry *is*: a message a person or the
   * model wrote is read from the top, so its head is kept; text folded back in from the live stream
   * is the run's own ending, so its tail is.
   * @param record - the session's record.
   * @param line - one message's text, or one line about a failure.
   * @param keep - which end of an over-long entry survives.
   */
  const note = (record, line, keep = 'head') => {
    const text = String(line ?? '').trim()
    if (text === '') return
    const copy = messages()
    const bounded = keep === 'tail'
      ? clipTailToBytes(text, copy.truncated, RUN_BUDGET)
      : clipToBytes(text, copy.truncated, RUN_BUDGET)
    // The entry was clipped on its own way in, and that is a loss a reader should hear about too:
    // it is part of this run's text that the card will not show.
    if (bounded !== text) record.dropped += rawBytes(text) - rawBytes(bounded)
    record.process.push(bounded)
    record.processSize += rawBytes(bounded)
    // Oldest first, because the end of a run is what a reader is looking for.
    while (record.processSize > RUN_BUDGET && record.process.length > 1) {
      record.dropped += rawBytes(record.process[0])
      record.runEntriesLost += 1
      record.processSize -= rawBytes(record.process[0])
      record.process.shift()
    }
  }

  /**
   * Add a tool call as one short line, collapsing a run of the same kind.
   *
   * The count is written into the line already there rather than appended as another line, which is
   * what keeps a hundred-step run from spending a hundred lines of the budget.
   * @param record - the session's record.
   * @param name - the wire tool name, which decides the kind.
   */
  const noteTool = (record, name) => {
    const copy = messages()
    const kind = TOOL_KINDS[name] ?? 'other'
    const label = copy.toolKind(kind, name)
    if (record.lastKind === kind && record.process.length > 0) {
      record.lastKindCount += 1
      const counted = copy.toolKindRepeated(label, record.lastKindCount)
      // Replaced in place: the line it supersedes is removed from the running total, so a counted
      // line costs the budget once rather than growing with every call.
      const previous = record.process[record.process.length - 1]
      record.processSize += rawBytes(counted) - rawBytes(previous)
      record.process[record.process.length - 1] = counted
      return
    }
    record.lastKind = kind
    record.lastKindCount = 1
    note(record, label)
  }

  /** Move the run being followed into the finished list and start a fresh one. */
  const closeTurn = (record) => {
    if (record.process.length > 0) {
      record.turns.push(record.process)
      while (record.turns.length > TURN_HISTORY) {
        const gone = record.turns.shift()
        for (const entry of gone) record.dropped += rawBytes(entry)
      }
    }
    record.process = []
    record.processSize = 0
    record.runEntriesLost = 0
    record.streamed = []
    record.streamSize = 0
    record.streamedStep = undefined
    record.committedStep = undefined
    record.lastKind = undefined
    record.lastKindCount = 0
  }

  /**
   * Add one live delta to the step's stream, keeping the newest of it.
   * @param record - the session's record.
   * @param text - one visible delta.
   */
  const stream = (record, text) => {
    record.streamed.push(text)
    record.streamSize += rawBytes(text)
    while (record.streamSize > RUN_BUDGET && record.streamed.length > 1) {
      record.dropped += rawBytes(record.streamed[0])
      record.streamSize -= rawBytes(record.streamed[0])
      record.streamed.shift()
    }
  }

  return {
    /**
     * Follow one session event into the run being recorded.
     * @param session - the session, as the firehose reports it.
     * @param event - the committed event.
     */
    observe(session, event) {
      if (session?.id === undefined) return
      const type = event?.type
      // Created on the way in rather than at `turn/start`, because a person's message can arrive
      // before the loop opens a turn — and a run that began before its first turn boundary is
      // exactly the run somebody is asking about.
      const record = recordOf(session.id)

      if (type === 'turn/start') {
        // A turn that ended before this one is a finished run; it stays in the list so a frozen card
        // keeps the sequence it always had.
        if (record.process.length > 0 || record.turns.length > 0) closeTurn(record)
        // A new turn belongs to whatever the run is already about, so the anchor is left alone: the
        // run started when somebody last spoke, not when the loop opened a turn.
        return
      }

      const turn = event.data?.turn
      if (typeof turn === 'number') record.turn = turn

      if (type === 'step/start') {
        record.streamed = []
        record.streamSize = 0
        record.streamedStep = undefined
        return
      }
      if (type === 'tool/call') {
        // Kept because a `tool/result` names no tool of its own: the call that produced it is the
        // only thing that knows which one failed.
        record.lastTool = event.data?.name
        noteTool(record, event.data?.name)
        return
      }
      if (type === 'tool/result') {
        // Only a result appended to the surface is this run's news; one that replaced earlier nodes
        // is compaction restating what the record already holds.
        if (event.surfaceOp !== 'append') return
        const block = event.data?.message?.content?.[0]
        const failure = event.data?.error
        if (block?.isError === true || failure !== undefined) {
          // Three places a reason can live, in the order they are worth reading. `error` carries a
          // kind and a code, not prose — the prose is in the result's own content.
          const reason = [
            typeof failure?.reason === 'string' ? failure.reason : '',
            textOf(block?.content),
            [failure?.name, failure?.code].filter(Boolean).join(' '),
          ].find(candidate => candidate !== '') ?? ''
          note(record, messages().activityToolFailed(
            record.lastTool ?? '',
            clipToBytes(reason, messages().truncated, 300),
          ))
          // A failure ends the run of a kind, so the next call starts its own line rather than being
          // counted into one that already carries a failure.
          record.lastKind = undefined
          record.lastKindCount = 0
        }
        return
      }
      if (type === 'user/message') {
        // Only a person's own words anchor a run: plugin-injected context renders as folded text
        // rather than as the reader's own message, and is part of what the run was told, not the
        // question the run is answering.
        if (event.data?.source?.kind !== 'user') return
        // Somebody spoke, so what came before is no longer what they are asking about: the run
        // starts again here and the text before it is dropped, which is what bounds this store.
        // `dropped` is deliberately *not* reset: it counts what the whole fold has lost, and a fold
        // that reported only its newest run's losses would under-report what a reader is missing.
        if (record.process.length > 0) closeTurn(record)
        note(record, textOf(event.data?.content))
        return
      }
      if (type === 'assistant/message') {
        // Only a message appended to the surface is new text; compaction rewrites earlier nodes.
        if (event.surfaceOp !== 'append') return
        const step = event.data?.step
        note(record, textOf(event.data?.message?.content))
        // Remembered so `turn/end` can tell that this step's text is already in the record. The live
        // frames carry the same words, and only one of the two routes may fold them.
        if (step !== undefined) record.committedStep = step
        return
      }
      if (type === 'turn/end') {
        // The card face shows only the newest fragments, so a run whose text arrived entirely as
        // live frames would close with a record that never saw most of it. What is folded is the
        // whole streamed step, and it is skipped when that step's committed message already went in.
        const shown = record.streamed.join('')
        const alreadyFolded = record.streamedStep !== undefined
          && record.streamedStep === record.committedStep
        if (shown !== '' && !alreadyFolded) note(record, shown, 'tail')
      }
    },

    /**
     * Follow one live stream frame into the run being recorded.
     * @param session - the session the attempt belongs to.
     * @param frame - the start, chunk or end publication.
     */
    observeStream(session, frame) {
      if (session === undefined || frame === undefined) return
      const record = records.get(session)
      if (record === undefined) return
      if (frame.type === 'start') {
        record.step = frame.step ?? record.step
        record.streamed = []
        record.streamSize = 0
        record.streamedStep = undefined
        return
      }
      if (frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type !== 'text-delta') return
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      if (text === '') return
      stream(record, text)
      // Which step these frames belong to, taken from the `start` frame that opened this attempt:
      // a `chunk` frame carries no step of its own.
      record.streamedStep = record.step
    },

    /**
     * What the run being followed did, and only that run.
     *
     * This is the reader the result card uses: it answers "what happened since I last spoke", and
     * earlier finished runs are a different question that a frozen card asks instead. Keeping the
     * two readers apart is what makes "the last human message is the anchor" visible in the output
     * rather than only true of the storage.
     * @param session - the session id.
     * @returns the run's entries, whether it has any, and what the bound left out of it.
     */
    readRun(session) {
      const record = records.get(session)
      if (record === undefined) return { entries: [], dropped: 0, entriesLost: 0 }
      return {
        entries: [...record.process],
        dropped: record.dropped,
        entriesLost: record.runEntriesLost,
      }
    },

    /**
     * What one session's record holds, as the entries a frozen card renders.
     *
     * The run being followed first, then what earlier finished runs left, because a reader opening
     * this is asking what happened and the newest answer is the one they mean.
     * @param session - the session id.
     * @returns the entries, how many bytes the bound left out, and the turns they came from.
     */
    read(session) {
      const record = records.get(session)
      if (record === undefined) return { entries: [], dropped: 0, turns: [] }
      const turns = [...record.turns, record.process].filter(entries => entries.length > 0)
      return {
        entries: turns.flatMap(entries => entries),
        dropped: record.dropped,
        // The shape a frozen card renders: whole turns, kept apart.
        turns,
      }
    },

    /** Whether anything is being recorded for one session, for the suite and for diagnostics. */
    has: (session) => records.has(session),
    /** The sessions being recorded, least recently used first. */
    order: () => [...records.keys()],
    /** Forget everything, on disposal. */
    clear: () => { records.clear() },
  }
}
