/**
 * Result notices: the answer a stopped session produced, handed to the phone
 * with a box for the next instruction.
 *
 * The answer is the same one the Web GUI leaves unfolded: the turn's last
 * Assistant message, which carries reply text and no tool call. Everything
 * before it — the tool calls and the messages that also called a tool — is the
 * process the GUI folds away, and a notice must not carry it.
 *
 * A notice is not a decision on a live request. The desktop is not asked
 * anything, so nothing races it: the notifier waits until the session is
 * genuinely quiet, then offers the answer. An instruction that comes back is
 * the reader's own message on a remote surface, and is recorded as human input
 * for that reason — see `send()`.
 *
 * @module pocket-console/results
 */

import { CARD_TEXT_BUDGET, clipTailToBytes, clipToBytes, looksLikeSizeRefusal } from './budget.js'
import { titleOf, workspaceLabel } from './identity.js'
import { PHONE as PRIORITY_PHONE, DESK as PRIORITY_DESK } from './priority.js'
import { RESTORE_LIMIT, createNoticeStore } from './notice-store.js'

import { randomUUID } from 'node:crypto'

/** Form field carrying the instruction typed on the phone. */
const INSTRUCTION_FIELD = 'value'

/**
 * Whether one Assistant message is a turn's answer.
 *
 * A message that both speaks and calls a tool is process, not answer — that is
 * why the intermediate "round N result" messages stay folded.
 * @param message - the recorded message, absent when the turn produced none.
 * @returns whether it satisfies the answer conditions.
 */
export function isAnswer(message) {
  return message !== undefined && message.hasToolCall !== true && message.text.trim() !== ''
}

/** How many sessions are observed at once before the coldest are forgotten. */
const TRACK_CAPACITY = 256

/** Bytes of UTF-8, which is what a size the platform counts and a size this code counts agree on. */
const rawBytes = (value) => Buffer.byteLength(String(value ?? ''), 'utf8')

/**
 * What this run did, as one block of text, keeping both ends and naming what it left out.
 *
 * Why both ends rather than a prefix: the two things a person decides on are **what the run set out
 * to do** and **where it stopped**, and in a long run those are the first and last parts of it. A
 * prefix keeps the plan and loses the ending; a suffix keeps the ending and loses the plan. Neither
 * alone answers "what happened", so the middle is what gives way — and it is named, because a reader
 * who is not told cannot tell a short run from a truncated one.
 *
 * `dropped` is the record's own count of what its bound discarded; the space this has to split is
 * whatever the marker and the card's budget leave, so a run that already lost its middle upstream
 * does not lose a second middle here silently.
 * @param entries - the run's entries, in order.
 * @param dropped - bytes the record itself left out, if any.
 * @param copy - the copy table in force.
 * @param budget - the byte budget for this block.
 * @returns the text, or an empty string when there is nothing to show.
 */
function runBlock(entries, dropped, copy, budget) {
  const shown = entries.filter(entry => entry !== '')
  if (shown.length === 0 && dropped === 0) return ''
  const whole = shown.join('\n\n')
  // The record's own loss is part of what the reader is missing, so it is charged before anything
  // else: a card that says nothing about it would present a partial run as a complete one.
  const carried = dropped > 0 ? copy.resultOmitted(dropped) : ''
  if (rawBytes(whole) + rawBytes(carried) <= budget) {
    return [whole, carried].filter(part => part !== '').join('\n\n')
  }

  const marker = copy.resultOmitted(0)
  const room = budget - rawBytes(carried) - rawBytes(marker)
  if (room <= 0) return carried
  // Halved: one end of the room for the head, one for the tail, so a long run shows both.
  const perEnd = Math.floor(room / 2)

  /**
   * One end of the run, taking entries until its half is used.
   *
   * The **first** entry is taken whatever it costs. A plan is a single message and it is routinely
   * longer than half of what the marker leaves, so a rule that took only what fit would drop the head
   * every time a run had a plan in it — the one thing this exists to show. It is clipped to the room
   * that remains instead, so the bound still holds.
   * @param entries - the run's entries, this end first.
   * @param limit - the bytes this end may use.
   * @param keep - which end of an entry too long for this end survives.
   * @returns the rendered lines, and the bytes of the run's *original* text they account for.
   */
  const takeEnd = (entries, limit, keep) => {
    const lines = []
    let used = 0
    let accounted = 0
    for (const entry of entries) {
      const size = rawBytes(entry) + 2
      if (lines.length === 0 && size > limit) {
        const roomLeft = Math.max(1, limit)
        // Which end is kept is the honest one for where this text sits: the start of a run should
        // keep its opening, the end of one should keep its conclusion.
        const clipped = keep === 'tail'
          ? clipToBytes(entry, copy.truncated, roomLeft)
          : clipTailToBytes(entry, copy.truncated, roomLeft)
        lines.push(clipped)
        // Accounted for as the original, because the reader is not missing this entry — only part of
        // it. What they *are* missing is what the marker is for, and it is counted below as the
        // difference, which is the only count that stays true when an entry is clipped rather than
        // dropped whole.
        accounted += size
        used += rawBytes(clipped) + 2
        break
      }
      if (used + size > limit) break
      lines.push(entry)
      used += size
      accounted += size
    }
    return { lines, accounted }
  }

  const head = takeEnd(shown, perEnd, 'tail')
  // The tail draws only from what the head did not take, so an entry is never shown twice.
  const remaining = shown.slice(head.lines.length)
  const tail = takeEnd([...remaining].reverse(), perEnd, 'head')
  // What the two ends account for, against the whole run: the difference is what the reader cannot
  // see, and it includes a clipped entry's tail as well as every entry no end had room for.
  const total = shown.reduce((sum, entry) => sum + rawBytes(entry) + 2, 0)
  const lost = Math.max(0, total - head.accounted - tail.accounted) + dropped
  return [
    head.lines.join('\n\n'),
    copy.resultOmitted(lost),
    [...tail.lines].reverse().join('\n\n'),
  ].filter(part => part !== '').join('\n\n')
}

/**
 * Watch root sessions, then offer each stopped session's answer to the channel.
 * @param options - the host context, the logger, the channel, the settings, the copy, the workspace
 *   registry, the priority state, the record of what each run did, and what to offer once a notice
 *   has gone out.
 */
export function createResultNotifier({
  ctx, log, channel, settings, messages, workspaces, priority, runRecord, onSent, now = () => Date.now(),
}) {
  /** Per-session observation: the newest turn, its last message, and when we last spoke. */
  const tracks = new Map()
  /** Notices whose rid is still live, keyed by that rid. */
  const notices = new Map()
  /** Where those notices are remembered between runs. */
  const store = createNoticeStore({ ctx, log, messages })
  /** Set while the notifier is unloaded: a restore in flight must not outlive it. */
  let disposed = false
  /** Set once the notices from the previous run have been read back. */
  let restored = false
  /** Set while a restore is in flight, so the two triggers cannot both run it. */
  let restoring = false

  /**
   * The wait in force: the configured calm window, or none while the phone has the person.
   *
   * Resolved here so neither the arming path nor the re-timing path has to know which side
   * the person is on, and so a deployment composed without the priority machine keeps the
   * setting it configured.
   */
  const effectiveDelay = () => priority?.delaySeconds() ?? settings().delaySeconds

  /**
   * The workspace one session belongs to, resolved once per notice.
   *
   * Read through the live agent, which is what this process is watching: the workspace
   * is needed at the moment a card goes out — when the session is by definition loaded
   * — and the answer is then carried on the notice, so no later rewrite has to read
   * anything. A session with no agent, or with no working directory in its header, is
   * left unnamed rather than labelled with a guess.
   * @param session - the session id.
   * @returns the label, or undefined when there is nothing to show.
   */
  const workspaceOf = (session) => workspaceLabel(ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd)

  /**
   * One session's observation state.
   *
   * The map is bounded because a long-running deployment meets every session it
   * ever notifies about, and nothing else retires them: a track is small, but
   * "one per session forever" is still a leak in a process that stays up for
   * weeks. Eviction only ever drops a track that is not waiting on a notice, so
   * a session about to notify keeps its place.
   */
  const trackOf = (session) => {
    let track = tracks.get(session)
    if (track === undefined) {
      forgetColdest()
      track = {
        turn: undefined, message: undefined, ended: undefined,
        timer: undefined, sentAt: undefined, eligible: false, touched: now(),
      }
      tracks.set(session, track)
    } else {
      track.touched = now()
    }
    return track
  }

  /** Drop the coldest idle tracks until the map is inside its capacity. */
  const forgetColdest = () => {
    if (tracks.size < TRACK_CAPACITY) return
    const idle = [...tracks.entries()]
      .filter(([, track]) => track.timer === undefined)
      .sort((left, right) => left[1].touched - right[1].touched)
    // Half the map at once, so the sort is paid for rarely rather than per event.
    for (const [session] of idle.slice(0, Math.max(1, Math.floor(TRACK_CAPACITY / 2)))) {
      tracks.delete(session)
    }
  }

  /**
   * Arm one session's calm window against the wait in force right now.
   *
   * The deadline is this activity plus the wait, not the wait counted from now, so
   * re-arming an edit keeps the time already spent: a session that has been calm for
   * 100 of 120 seconds and meets a 20-second value notifies now.
   * @param session - the session whose window is being (re-)set.
   * @param track - that session's observation state.
   */
  const rearmOne = (session, track) => {
    if (track.timer !== undefined) clearTimeout(track.timer)
    const deadline = track.touched + effectiveDelay() * 1000
    track.timer = setTimeout(() => {
      track.timer = undefined
      // A throw here would be an uncaught exception, which the harness treats as
      // fatal: a notification must never be able to end the process.
      void fire(session).catch(error => { log.warn(messages().logNoticeFailed, error) })
    }, Math.max(0, deadline - now()))
    track.timer.unref?.()
  }

  /**
   * Restart the quiet window. Any activity in the session calls this, so a run
   * of turns collapses into one notice after the last one stops.
   */
  const arm = (session) => {
    if (disposed) return
    rearmOne(session, trackOf(session))
  }

  /**
   * Re-time every session still inside its calm window against a changed wait.
   *
   * The window is a countdown, and it was armed from the value in force when the
   * session last moved: an edit has to reach a notice that is already counting down,
   * or the setting appears not to work until the next turn.
   */
  const rearm = () => {
    if (disposed) return
    for (const [session, track] of tracks) {
      // Only a window that is already running is re-timed; a track with no timer is
      // not waiting to notify anybody.
      if (track.timer === undefined) continue
      rearmOne(session, track)
    }
  }

  /** Offer the stopped session's answer, once the session is actually quiet. */
  const fire = async (session) => {
    const track = trackOf(session)
    if (settings().resultNotify !== 'idle') return
    // Only a turn that ended and was not superseded: a newer turn means the
    // session kept working, and the newer one owns the next notice.
    if (!track.eligible || track.ended === undefined || track.ended !== track.turn) return
    if (!isAnswer(track.message)) return
    const delay = settings().resultNotifyCooldownSeconds * 1000
    if (track.sentAt !== undefined && now() - track.sentAt < delay) {
      log.debug(messages().logNoticeCooling)
      return
    }
    // `ctx.get`, not `ctx.agents`: reading a service property without an
    // `inject` declaration throws, and this feature is optional.
    const agent = ctx.get?.('agents')?.get?.(session)
    if (agent === undefined) {
      log.debug(messages().logNoticeNoAgent)
      return
    }
    if (agent.status !== 'idle') {
      // Still working: wait another window instead of reporting a half result.
      arm(session)
      return
    }

    const id = noticeId()
    // A long result would otherwise be refused by the platform and the notice
    // would never arrive, which is worse than a clipped one that says so.
    let answer = clipToBytes(track.message.text, messages().truncated)
    // One live notice per session: the newest result is the one worth replying
    // to, and an older card that still accepted a reply would inject an
    // instruction the reader wrote against a superseded answer.
    retire(session, messages().superseded)
    // Resolved once, then carried: this card is rewritten when the reader replies and
    // when a newer result supersedes it, and those rewrites must say the same thing.
    const workspace = workspaceOf(session)
    const view = {
      title: titleOf(`${settings().titlePrefix} ${messages().resultTitle}`, workspace),
      tone: 'info',
      body: [answer, messages().replyHint],
      buttons: [],
      forms: [{ payload: { nid: id, submit: true }, fieldId: INSTRUCTION_FIELD, submitLabel: messages().sendToAgent }],
    }
    noticeSet(id, { session, handle: undefined, workspace })
    track.ended = undefined
    track.sentAt = now()
    // What the run did, from the last thing a person said to the moment it stopped. The card face
    // keeps the answer, because that is what a reader glances at; the run goes in the fold beside it,
    // which the channel renders as a panel the reader opens in place. Nothing is sent for it: the
    // message count per run does not change, which is the promise that makes this card acceptable.
    const run = runRecord?.readRun?.(session) ?? { entries: [], dropped: 0 }
    const details = (() => {
      const blocks = runBlock(run.entries, run.dropped, messages(), Math.floor(CARD_TEXT_BUDGET / 2))
      return blocks === '' ? undefined : { title: messages().resultProcess, blocks: [blocks] }
    })()
    if (details !== undefined) view.details = details
    // Said out loud, because the two ways this ends up absent look identical on the phone: a card
    // with no fold is what a run the record never saw produces too. The count is what tells them
    // apart, and a reader who reports "there is no panel" is otherwise unanswerable. The shape of
    // the view goes with it, so a report can be checked against what was actually sent rather than
    // against what the reporter could see on a phone.
    log.debug(messages().logRunFold(session, run.entries.length, details !== undefined))
    log.debug(messages().logResultView(JSON.stringify({
      elements: view.body.length,
      details: view.details === undefined ? null : {
        title: view.details.title,
        blocks: view.details.blocks.length,
        first: String(view.details.blocks[0] ?? '').slice(0, 160),
      },
      body: view.body.map(part => String(part).slice(0, 60)),
    })))
    try {
      const handle = await channel.deliver(view).catch(async (error) => {
        if (!looksLikeSizeRefusal(error)) throw error
        log.debug(messages().logNoticeTooLarge)
        answer = clipToBytes(track.message.text, messages().truncated, Math.floor(CARD_TEXT_BUDGET / 2))
        return await channel.deliver({ ...view, body: [answer, messages().replyHint] })
      })
      const notice = notices.get(id)
      if (notice !== undefined) notice.handle = handle
      // Remembered against the message as well, so a press that finds no live notice can
      // still be told which session the card belonged to.
      workspaces?.record(handle, workspace)
      log.info(messages().logNoticeSent)
      // The card is delivered, a press can find it, and this is the moment the phone has the
      // person's attention — so it is the moment to offer the one thing a result cannot: the next
      // shard, in a session of its own. A hook rather than a call into that module, because what
      // the phone does about a finished run is not this notifier's business, and a deployment
      // composed without it must still deliver results.
      if (typeof onSent === 'function') await onSent(session)
      // Remembered only now: a card that never arrived has nothing to put back, and the
      // session's last seq is what a later run compares against to see whether the
      // session moved on while this process was not there to notice.
      void store.put({
        rid: id,
        session,
        handle,
        workspace,
        seq: await sessionSeq(session),
        sentAt: track.sentAt,
      }).then(() => { log.info(messages().logNoticeStored(id)) })
    } catch (error) {
      notices.delete(id)
      log.warn(messages().logNoticeSendFailed, error)
    }
  }

  /**
   * One session's last event seq, or undefined when it cannot be read.
   *
   * Recorded with a notice so that a later process can ask whether a person has spoken
   * since — the one rule that cannot be re-applied from memory after a restart, because
   * what happened while the process was down left no trace in it.
   * @param session - the session the notice reports on.
   * @returns the highest captured seq, or undefined.
   */
  async function sessionSeq(session) {
    const query = ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.readSurface !== 'function') return undefined
    try {
      const surface = await query.readSurface(session)
      const seq = surface?.capturedThroughSeq
      return typeof seq === 'number' ? seq : undefined
    } catch (error) {
      log.warn(messages().logNoticeStoreReadFailed, error)
      return undefined
    }
  }

  /**
   * Whether a person has spoken in one session since the notice went out.
   *
   * The live path learns this from the event stream; a process that starts later cannot,
   * so it asks the session's own log. Only `user/message` counts, because a session
   * writes other events of its own accord — a generated title, for one — and retiring a
   * notice over those would take away a card nothing had actually superseded.
   * @param session - the session the notice reports on.
   * @param seq - the session's last event when the notice went out.
   * @returns true, false, or undefined when there is no way to tell.
   */
  async function spokeSince(session, seq) {
    const query = ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.filterEvents !== 'function') return undefined
    try {
      const found = await query.filterEvents(session, [
        { kind: 'seq', from: seq + 1 },
        { kind: 'type', values: ['user/message'] },
      ])
      return Array.isArray(found) && found.length > 0
    } catch (error) {
      log.warn(messages().logNoticeStoreReadFailed, error)
      return undefined
    }
  }

  /**
   * Whether one session still exists at all, live or only persisted.
   *
   * A session is not gone because it has no live agent: a restart leaves every session
   * dormant, and the Web client resumes one when it is opened. So the question is asked
   * of the durable corpus, not of the live registry — asking the registry would retire a
   * notice for an ordinary restart, which is the bug this whole path exists to fix.
   * @param session - the session the notice reports on.
   * @returns true, false, or undefined when there is no way to tell.
   */
  async function sessionExists(session) {
    // A live agent is proof on its own: whatever the corpus says, this session is here.
    // The check exists to avoid retiring a notice over an ordinary restart, so it must
    // not be able to do so on a listing that simply does not see the session yet.
    if (ctx.get?.('agents')?.get?.(session) !== undefined) return true
    const query = ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.filterSessions !== 'function') return undefined
    try {
      const found = await query.filterSessions([{ kind: 'id', values: [session] }])
      return Array.isArray(found) && found.length > 0
    } catch (error) {
      log.warn(messages().logNoticeStoreReadFailed, error)
      return undefined
    }
  }

  /**
   * Put back the notices that were live before this process started.
   *
   * A notice is an offer with no time limit, so a restart must not quietly withdraw it —
   * that is what it did while the registry was memory only, and the card blamed an
   * expiry that never happened. Each restored notice is re-checked against the same
   * rules instead: the session may have been deleted, or it may have moved on while this
   * process was not running to see it. With no way to tell, the notice stands, which is
   * what the documented promise says it does.
   *
   * A restored notice whose session is merely dormant stays replyable: the reply needs a
   * live agent, and the live path already refuses one honestly until the session is
   * resumed — by the desk, which is where the session belongs.
   */
  async function restore() {
    // Two triggers call this — installing the listener, and the storage service becoming
    // available — and either may be the one that finds the medium up. Only one of them
    // may do the work, and an attempt that found no medium yet leaves it to the other
    // rather than marking the restore done.
    if (restored || restoring) return
    restoring = true
    try {
      if (!await store.ensureOpen()) return
      restored = true
      await restoreFromStore()
    } finally {
      restoring = false
    }
  }

  /** Read the stored notices back and put each through the rules that retire one. */
  async function restoreFromStore() {
    const stored = await store.open()
    if (stored.length === 0) {
      // Diagnostic: an ordinary startup has nothing to restore, and saying so every time
      // would be noise rather than news.
      log.debug(messages().logNoticeRestoreEmpty)
      return
    }
    let kept = 0
    for (const record of stored) {
      if (disposed) return
      if (await sessionExists(record.session) === false) {
        // The session itself is gone, so there is nothing left to instruct.
        retireRestored(record, messages().noticeGone)
        continue
      }
      if (kept >= RESTORE_LIMIT) {
        // More outstanding notices than a reader could act on: the oldest are retired
        // rather than left as a growing pile of cards that all claim to be live.
        retireRestored(record, messages().superseded)
        continue
      }
      if (record.seq !== undefined && await spokeSince(record.session, record.seq) === true) {
        retireRestored(record, messages().readerSpoke)
        continue
      }
      noticeSet(record.rid, { session: record.session, handle: record.handle, workspace: record.workspace })
      kept += 1
    }
    if (kept > 0) log.info(messages().logNoticeRestored(kept))
  }

  /**
   * Retire one notice that came back from the previous run.
   *
   * Which rule fired is logged, because from outside every one of them looks the same:
   * a card that no longer takes a reply. Telling them apart is the difference between a
   * session that moved on and a check that simply cannot see it.
   * @param record - the stored notice.
   * @param reason - the copy naming the rule that retired it.
   */
  function retireRestored(record, reason) {
    log.info(messages().logNoticeRestoreRetired(record.rid, reason))
    retract(record.handle, reason, record.workspace)
    void store.remove(record.rid)
  }

  /** Record one notice; the map is the rid's validity window for this run. */
  function noticeSet(id, notice) {
    notices.set(id, notice)
  }

  /**
   * Retire every outstanding notice for one session.
   *
   * A notice is an offer to reply, and it is only honest while the result it
   * carries is still the session's latest word. Superseding, new input, and the
   * age limit all end it the same way: the rid stops being accepted and the card
   * says why.
   * @param session - the session whose notices are dropped.
   * @param headline - what the card says instead of the input box.
   * @returns how many notices were retired.
   */
  const retire = (session, headline) => {
    let retired = 0
    for (const [id, notice] of [...notices]) {
      if (String(notice.session) !== String(session)) continue
      notices.delete(id)
      // Forgotten durably as well: a retired notice must not come back to life when the
      // next run reads the store, and its rid must never be replyable again.
      void store.remove(id)
      retired += 1
      if (notice.handle === undefined) continue
      retract(notice.handle, headline, notice.workspace)
    }
    if (retired > 0) log.debug(messages().logNoticeRetired(headline))
    return retired
  }

  /**
   * Take the reply control off a notice card that is no longer live.
   *
   * A notice card outlives the process that sent it: the map is in memory, so after a
   * restart a press found nothing and answered with a toast alone, leaving a card that
   * still looked like it would take a reply. The press carries the message it came from,
   * so the card is rewritten where it lies.
   * @param handle - the message the press came from, as the channel reported it.
   * @param headline - what the card says instead.
   * @param workspace - the label the card was sent with, so the rewrite agrees with it.
   */
  function retract(handle, headline, workspace) {
    if (handle === undefined || typeof channel.update !== 'function') return
    void Promise.resolve(channel.update(handle, {
      title: titleOf(`${settings().titlePrefix} ${messages().resultTitle}`, workspace),
      tone: 'muted',
      body: [headline],
      buttons: [],
      forms: [],
    })).catch(error => { log.warn(messages().logNoticeCardFailed, error) })
  }

  /**
   * An unguessable, single-use notice rid.
   *
   * The same construction the escalation registry uses, for the same reason: this id
   * decides whether a reply is accepted, so it is drawn from the platform's CSPRNG
   * rather than `Math.random()`, whose stream is not meant to be unpredictable.
   * @returns a fresh notice id.
   */
  function noticeId() {
    return `n${randomUUID().replaceAll('-', '').slice(0, 20)}`
  }

  /** Observe one session event. */
  const onEvent = (session, event) => {
    if (session?.id === undefined) return
    const track = trackOf(session.id)
    const source = event.data?.source ?? event.data?.message?.source
    if (event.type === 'user/message' && source?.kind === 'user') {
      // Only a session a person started is worth reporting; a delegated one is
      // reported through the session that asked for it.
      track.eligible = true
      // Somebody spoke — at the desk or from the phone. Whatever the notice
      // carried is no longer the session's latest word, so it stops taking
      // replies instead of injecting one into a conversation that moved on.
      retire(session.id, messages().readerSpoke)
      // Typing into the desktop composer is a person at the desk, and it is the one signal for
      // that which this deployment can see at all. The browser reaches the session through the
      // gateway's session controller, whose `source` carries the caller's own request id; every
      // other path that mints a `{ kind: 'user' }` message does not — the message this plugin
      // itself sends from a phone card, the headless and SDK entry points, and the plugin-injected
      // context that renders as folded text rather than as the reader's own words. `rpcId` is
      // therefore what separates a person typing at the desk from everything else, and it is read
      // defensively because it is not part of the declared source type.
      if (typeof source.rpcId === 'string' && source.rpcId !== '') priority?.set(PRIORITY_DESK)
    }
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      const blocks = event.data?.message?.content ?? []
      track.message = {
        turn: event.data.turn,
        text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
        hasToolCall: blocks.some(block => block.type === 'tool-call'),
      }
      arm(session.id)
      return
    }
    if (event.type === 'turn/start') {
      track.turn = event.data?.turn
      track.message = undefined
      track.ended = undefined
      arm(session.id)
      return
    }
    if (event.type === 'turn/end') {
      if (event.data?.reason?.kind !== 'completed') return
      track.ended = event.data.turn
      arm(session.id)
    }
  }

  /**
   * Route one phone action. Returns undefined when it names no live notice, so
   * the core keeps decoding approvals and question answers.
   * @param action - what the channel reported: the echoed payload, the submitted
   *   values, and the message the press came from.
   * @returns the channel's toast response, or undefined.
   */
  function handleAction({ payload, values, messageId } = {}) {
    const id = typeof payload?.nid === 'string' ? payload.nid : undefined
    if (id === undefined) return undefined
    const notice = notices.get(id)
    if (notice === undefined) {
      // A press may only conclude that the notice is gone once this side has finished
      // looking. While the store is still opening, or a restore is still running, the
      // notice may be about to appear — and retiring the card then would throw away one
      // that is still valid, which is exactly what the durable record exists to prevent.
      // An early press therefore reports and changes nothing, leaving the card usable for
      // the moment the process can actually serve it.
      if ((store.isOpen() && restored) || store.unavailable()) {
        // Even then the card says only what this side knows: it is not live here. It
        // cannot tell whether it was superseded, whether the reader moved the session on,
        // or whether the process that held it is gone — and an earlier rewrite may already
        // be showing the true reason, which "expired" would replace with a guess. The
        // workspace is not a guess: it was remembered against the message when the card
        // went out, which is what a restart cannot take away.
        retract(messageId, messages().noticeStale, workspaces?.lookup(messageId))
      }
      return { toast: messages().noticeGone, accepted: false }
    }
    // The channel names the control and reports what it called it, because a card may
    // not hold two elements of the same name; a card that reported nothing is read
    // under the name this side asked for.
    const submitted = values?.[payload?.submits?.[INSTRUCTION_FIELD] ?? INSTRUCTION_FIELD]
    const text = typeof submitted === 'string' ? submitted.trim() : ''
    if (text === '') return { toast: messages().emptyInstruction, accepted: false }
    const agent = ctx.get?.('agents')?.get?.(notice.session)
    if (agent === undefined) {
      return { toast: messages().noAgent, accepted: false }
    }
    // Claim before sending: the first submission wins and the rid dies here — durably
    // too, so that no later run can put the card back and take the reply twice.
    notices.delete(id)
    void store.remove(id)
    void send(agent, text, notice)
    return { toast: messages().sent, accepted: true }
  }

  /** Deliver one instruction, then record it on the notice's own message. */
  async function send(agent, text, notice) {
    try {
      // A reply typed on the phone is a person at the phone, so the head start stops
      // applying to whatever this session does next. Re-timed on the spot, so the calm
      // window of the turn this instruction starts is the short one.
      if (priority?.set(PRIORITY_PHONE) === true) rearm()
      // Imported here rather than at load: the message constructor lives in the
      // harness, and a deployment without it must still load this plugin.
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        // Human input, minted by the surface the human is speaking through —
        // the same attribution the harness's own remote client gives a prompt
        // (`packages/acp/acp/src/session.ts`). A `{ kind: 'user' }` message is
        // what renders as the reader's own message in the Web flow and what
        // carries human authority; a plugin-sourced one renders as folded
        // injected context instead.
        source: { kind: 'user' },
      }))
      log.info(messages().logInstructionQueued)
      if (notice.handle !== undefined) {
        await Promise.resolve(channel.update(notice.handle, {
          title: titleOf(`${settings().titlePrefix} ${messages().resultTitle}`, notice.workspace),
          tone: 'success',
          body: [messages().received],
          buttons: [],
          forms: [],
        })).catch(error => { log.warn(messages().logNoticeCardFailed, error) })
      }
    } catch (error) {
      log.warn(messages().logInstructionFailed, error)
    }
  }

  return {
    /**
     * Start observing sessions.
     * @returns the disposer removing the listener.
     */
    install() {
      disposed = false
      const off = ctx.on('session/event', onEvent)
      // Tried here as well as when the storage service arrives: whichever finds the
      // medium up does the work, and the other becomes a no-op.
      void restore().catch(error => { log.warn(messages().logNoticeRestoreFailed, error) })
      return () => {
        disposed = true
        off()
        for (const track of tracks.values()) {
          if (track.timer !== undefined) clearTimeout(track.timer)
        }
        tracks.clear()
        // Only the in-memory half: what the store holds is what the *next* run reads,
        // and unloading a plugin is not the reader withdrawing their result.
        notices.clear()
        void store.close()
      }
    },
    /**
     * Bring back the notices from the previous run.
     *
     * Called by the plugin once the storage service is up rather than from `install()`:
     * a restore that ran first would find nothing and quietly leave the promise broken.
     * @returns resolution once every stored notice has been restored or retired.
     */
    restore,
    /**
     * Route one phone action to a live notice.
     * @param payload - the echoed payload.
     * @param values - submitted form values.
     * @returns the toast response, or undefined when this is not a notice action.
     */
    handleAction,
    /**
     * Re-time every session still inside its calm window against a changed wait.
     *
     * Called when the wait is edited: the window is a countdown, so without this an
     * edit reaches the next turn and not the notice the reader was watching.
     */
    rearm,
    /**
     * How many sessions are being observed right now.
     *
     * The bound is an invariant of a process that stays up for weeks, and nothing
     * else can observe it from outside: the map is the only state here that grows
     * with the deployment's lifetime, so the suite reads it directly rather than
     * inferring it from timing.
     * @returns the number of per-session records held.
     */
    trackedSessions: () => tracks.size,
  }
}
