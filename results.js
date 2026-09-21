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

import { CARD_ELEMENT_BUDGET, CARD_TEXT_BUDGET, clipTailToBytes, clipToBytes, looksLikeSizeRefusal } from './budget.js'
import { titleOf, workspaceLabel } from './identity.js'
import { PHONE as PRIORITY_PHONE, DESK as PRIORITY_DESK } from './priority.js'
import { RESTORE_LIMIT, createNoticeStore } from './notice-store.js'

import { randomUUID } from 'node:crypto'

/** Form field carrying the instruction typed on the phone. */
const INSTRUCTION_FIELD = 'value'

/**
 * Where on a sent card the result ends and the next-task offer begins.
 *
 * Carried on the view itself, because a card is rewritten after it is sent and the rewrite has to
 * know which paragraphs were the answer. It is deliberately not derived from the copy: matching the
 * sentence would break the day the wording changes, silently, and the failure mode is a card telling
 * the reader to use a control that is no longer on it.
 */
const RESULT_ENDS = 'resultEnds'

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
 * What this run did, as the groups a card renders, giving up the least useful thing first.
 *
 * A history that is always truncated is not a history. So the text is not trimmed to fit: **whole
 * kinds of content are given up, in order of what a reader can most afford to lose**, and only when
 * none of that is left does the oldest prose go. Each step is a decision a reader would make
 * themselves, and the order follows the judgement every card here uses — would this change what you
 * write next?
 *
 * 1. **All of it.** Prose, the person's own message, and one line per tool step.
 * 2. **Tools merged into one group.** Adjacent tool lines join into one block, costing one element
 *    instead of one each. Nothing is lost but line breaks — and the platform refuses a card over 200
 *    elements, which a hundred-step run reaches with its tool lines alone.
 * 3. **Tools dropped.** How far along a run got matters less than what it said.
 * 4. **The person's message dropped.** It is the context the run answers, which the reader usually
 *    remembers, and it is one long message that buys a lot of prose.
 * 5. **The oldest prose dropped.** Only now is text actually lost, and what goes is the oldest,
 *    because the newest output is the part a reader is deciding on.
 *
 * Whatever is given up is named with a byte count: a reader who is not told cannot tell a short run
 * from a truncated one.
 * @param entries - the run's entries, each carrying its kind.
 * @param dropped - bytes the record itself left out, if any.
 * @param copy - the copy table in force.
 * @param budget - the byte budget for this block.
 * @param maxGroups - how many elements this block may cost.
 * @returns the groups to render, or an empty array when there is nothing to show.
 */
function runGroups(entries, dropped, copy, budget, maxGroups) {
  const all = entries.filter(entry => entry.text !== '')
  if (all.length === 0 && dropped === 0) return []

  /**
   * Bytes of the run a level leaves out.
   *
   * Compared **by position**, not by text: a run that ran the same command twice has two entries
   * whose text is identical, and a set of the kept texts would count both as kept when only one was
   * — under-reporting what the reader is missing, which is the one thing this number exists to get
   * right.
   * @param kept - the entries this level keeps, in the order they appear in the run.
   * @returns the bytes a reader will not see.
   */
  const lostBytes = (kept) => {
    let at = 0
    let lost = 0
    for (const entry of all) {
      if (at < kept.length && kept[at] === entry) {
        at += 1
        continue
      }
      lost += rawBytes(entry.text) + 2
    }
    return lost
  }

  /** Adjacent tool lines, joined; every other kind left as it is. */
  const mergeTools = (kept) => {
    const out = []
    for (const entry of kept) {
      const last = out[out.length - 1]
      if (last !== undefined && last.kind === 'tool' && entry.kind === 'tool') {
        last.text += `\n${entry.text}`
        continue
      }
      out.push({ kind: entry.kind, text: entry.text })
    }
    return out
  }

  /**
   * The run at one level of detail, or nothing when either budget refuses it.
   * @param kept - the entries this level keeps.
   * @param merge - whether adjacent tool lines are joined into one group.
   * @returns the groups, or undefined when it does not fit.
   */
  const shape = (kept, merge) => {
    const grouped = merge ? mergeTools(kept) : kept
    const omitted = dropped + lostBytes(kept)
    const text = grouped.map(group => group.text).join('\n\n')
    const body = omitted > 0 ? `${text}\n\n${copy.resultOmitted(omitted)}` : text
    if (rawBytes(body) > budget) return undefined
    if (grouped.length + (omitted > 0 ? 1 : 0) > maxGroups) return undefined
    return grouped.map(group => group.text).concat(omitted > 0 ? [copy.resultOmitted(omitted)] : [])
  }

  const prose = all.filter(entry => entry.kind !== 'tool' && entry.kind !== 'failure')
  const proseOnly = prose.filter(entry => entry.kind !== 'human')
  // Each attempt keeps strictly less than the one before, so the first that fits is the most a
  // reader can be shown.
  for (const attempt of [
    () => shape(all, false),
    () => shape(all, true),
    () => shape(prose, true),
    () => shape(proseOnly, true),
  ]) {
    const shaped = attempt()
    if (shaped !== undefined) return shaped
  }

  // The last resort, and the only one that loses text: the newest prose, oldest first out.
  for (let from = 1; from <= proseOnly.length; from += 1) {
    const kept = proseOnly.slice(from - 1)
    const omitted = dropped + lostBytes(kept)
    const marker = copy.resultOmitted(omitted)
    const text = kept.map(entry => entry.text).join('\n\n')
    if (rawBytes(`${text}\n\n${marker}`) <= budget && kept.length + 1 <= maxGroups) return [text, marker]
    // Even one message can be too long on its own, and then its end is what a reader wants: it is
    // the message the run is on.
    if (kept.length === 1) {
      const clipped = clipTailToBytes(kept[0].text, copy.truncated, Math.max(1, budget - rawBytes(marker)))
      return [clipped, marker]
    }
  }
  return []
}

/**
 * Watch root sessions, then offer each stopped session's answer to the channel.
 * @param options - the host context, the logger, the channel, the settings, the copy, the workspace
 *   registry, the priority state, the record of what each run did, the next-task offer that rides on
 *   a settled card instead of costing a message of its own, and the activity card, which takes over
 *   the message a reply was typed on.
 */
export function createResultNotifier({
  ctx, log, channel, settings, messages, workspaces, priority, runRecord, nextTask, activity,
  diagnostics = () => {}, now = () => Date.now(),
}) {
  /** Per-session observation: the newest turn, its last message, and when we last spoke. */
  const tracks = new Map()
  /**
   * Notices whose rid is still live, keyed by that rid.
   *
   * Each notice also carries the card it went out as, under {@link VIEW}, because a notice's card is
   * rewritten more than once in its life — when the reader replies, when a newer result supersedes
   * it — and every rewrite has to carry the same result. The first version of that dropped
   * everything but a headline, which threw away the answer the reader had come back to read, and the
   * run fold went with it.
   *
   * **The view lives on the notice and not in a second map, and that is the point.** It used to be
   * a separate `Map` keyed by message, which meant two containers describing one thing and three
   * code paths that each had to remember to clean both. One of them could not: a card superseded
   * while its send was still in flight has no message to be keyed by yet, so the write that
   * eventually recorded the view found no notice to record it against and left it in memory for the
   * life of the process — one card's full text, per occurrence. Owning the view is what makes that
   * unrepresentable rather than merely fixed.
   */
  const notices = new Map()
  /**
   * Where a notice keeps the card it was sent as.
   *
   * A property on the notice rather than a map of its own: two containers with the same lifetime
   * drift, and this one did.
   */
  const VIEW = 'view'
  /** Where those notices are remembered between runs. */
  const store = createNoticeStore({ ctx, log, messages })
  /** Set while the notifier is unloaded: a restore in flight must not outlive it. */
  let disposed = false
  /** Set once the notices from the previous run have been read back. */
  let restored = false
  /** Set while a restore is in flight, so the two triggers cannot both run it. */
  let restoring = false
  /**
   * How many human messages have arrived carrying the gateway's request id, and how many have not.
   *
   * Counted so the desk-presence rule can be checked from the log rather than only believed — see
   * the one place `rpcId` is read, in {@link onEvent}.
   */
  let humanWithRequestId = 0
  /** The other half of that count: human messages with no request id beside them. */
  let humanWithoutRequestId = 0

  /**
   * The wait in force: the configured calm window, or none while the phone has the person.
   *
   * Resolved here so neither the arming path nor the re-timing path has to know which side
   * the person is on, and so a deployment composed without the priority machine keeps the
   * setting it configured.
   */
  const effectiveDelay = () => priority?.delaySeconds() ?? settings().delaySeconds

  /**
   * Give the message a reply was typed on to the run its instruction starts.
   *
   * The two modules are separate — one owns the run's card, one owns the card a result is offered
   * on — and this is the single seam between them. It is a call rather than a shared map because
   * only the run can say whether the message is free: a card whose first send is still in flight is
   * about to have a handle of its own, and taking one over before that lands would leave the
   * answer to that send editing a message nothing is looking at.
   *
   * Composed without the activity module, this is a no-op and the reply path keeps its own rewrite:
   * the card then says "已收到指令" and the run shows on a card of its own, which is what every
   * release before this one did.
   * @param session - the session the reply was made against.
   * @param handle - the message the reply came from.
   * @returns whether the run took the card over.
   */
  const adoptCard = (session, handle) =>
    handle !== undefined && activity?.adopt?.(session, handle) === true

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
   * The map is bounded because a long-running deployment meets every session it ever notifies about,
   * and nothing else retires them: a track is small, but "one per session forever" is still a leak in
   * a process that stays up for weeks. See {@link forgetColdest} for what the bound does when every
   * track in it is busy — which is the case it used to get wrong.
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

  /**
   * Drop the coldest tracks until the map is inside its capacity.
   *
   * Idle tracks go first, and that order is the point: a track with no timer is a session between
   * turns, and forgetting it costs nothing but a little state. A track whose calm window is still
   * counting down is a notice that is about to be offered, and dropping it means that session never
   * hears back.
   *
   * But the preference is a preference, not a shield. This used to skip every waiting track and then
   * stop, so a deployment where all of them were waiting held every session it had ever met — the
   * bound quietly not being one, which is the leak it exists to prevent. When nothing is idle the
   * coldest waiting tracks go: the notice each was about to produce is lost, which is a real cost,
   * but a process that grows without limit is a worse one. Reaching that branch needs
   * {@link TRACK_CAPACITY} sessions with a window open at the same instant.
   *
   * Half the map at once, so the sort is paid for rarely rather than per event.
   */
  const forgetColdest = () => {
    if (tracks.size < TRACK_CAPACITY) return
    /** Waiting tracks rank behind idle ones, and older behind newer within each kind. */
    const rank = (track) => (track.timer === undefined ? 0 : 1)
    const coldest = [...tracks.entries()].sort((left, right) => (
      rank(left[1]) - rank(right[1]) || left[1].touched - right[1].touched
    ))
    for (const [session, track] of coldest.slice(0, Math.max(1, Math.floor(TRACK_CAPACITY / 2)))) {
      // Cleared, not merely forgotten: a timer left running would fire for a session this map no
      // longer holds, and the notice it produced would be about a track that is gone.
      if (track.timer !== undefined) clearTimeout(track.timer)
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
    const groups = runGroups(
      run.entries,
      run.dropped,
      messages(),
      CARD_TEXT_BUDGET,
      CARD_ELEMENT_BUDGET,
    )
    if (groups.length > 0) view.details = { title: messages().resultProcess, blocks: groups }
    // Said out loud, because the two ways this ends up absent look identical on the phone: a card
    // with no fold is what a run the record never saw produces too. The count is what tells them
    // apart, and a reader who reports "there is no panel" is otherwise unanswerable. The shape of
    // the view goes with it, so a report can be checked against what was actually sent rather than
    // against what the reporter could see on a phone — including how much the layering gave up.
    log.debug(messages().logRunFold(session, run.entries.length, groups.length > 0))
    log.debug(messages().logResultView(JSON.stringify({
      body: view.body.length,
      entries: run.entries.length,
      // How many elements the fold costs, and how many groups it kept: the element count is a
      // platform limit of its own, and a fold that fits by size can still be refused by it.
      blocks: groups.length,
      dropped: run.dropped,
      first: String(groups[0] ?? '').slice(0, 160),
    })))
    /**
     * The card as it will go out, and as every later rewrite of it must look.
     *
     * The next-task offer rides here rather than on a card of its own: a result already ends on
     * "what now?", and a second card asking that question was one more notification for the same
     * run. What the offer is, and what it does to a card, belongs to the module that owns it, so
     * this only hands over the view and takes back the one to send.
     *
     * Only while the phone holds the person. What could come next is something the desk can see for
     * itself, and a result card that offered to start a session to somebody sitting at the desk
     * would be offering the desk a control it already has — the same rule that decides whether a
     * result is worth a message at all.
     */
    const offer = (base) => {
      // Where the **answer** ends. Everything the result card offers beyond the answer — the
      // sentence pointing at the reply box, and the whole next-task block — is added at send time,
      // so it all belongs to the same disposable layer. Recording the boundary at the answer is
      // what lets a rewrite drop the controls and their words together, instead of leaving a card
      // that tells the reader to reply to a box, or open a session with a form, that is not there.
      //
      // Derived from the body rather than from the copy: matching sentences would break silently the
      // day the wording changes, and the failure is a card that lies about what it can do.
      const ends = Math.max(1, base.body.length - 1)
      if (priority?.get?.() !== PRIORITY_PHONE) return { ...base, [RESULT_ENDS]: ends }
      const merged = typeof nextTask?.mergeInto === 'function' ? nextTask.mergeInto(base, session) : base
      return { ...merged, [RESULT_ENDS]: ends }
    }
    /** Assemble the card once, so the marker, the fold and the offer cannot disagree. */
    const cardFor = (text) => {
      const base = { ...view, body: [text, messages().replyHint] }
      return offer(base)
    }
    try {
      let card = cardFor(answer)
      const handle = await channel.deliver(card).catch(async (error) => {
        if (!looksLikeSizeRefusal(error)) throw error
        log.debug(messages().logNoticeTooLarge)
        answer = clipToBytes(track.message.text, messages().truncated, Math.floor(CARD_TEXT_BUDGET / 2))
        card = cardFor(answer)
        // The fold is what does not fit, so the fold is what is given up. The offer is cheaper than
        // it looks and stays: dropping it would take away the one control a result is worth having.
        delete card.details
        return await channel.deliver(card)
      })
      const notice = notices.get(id)
      if (notice !== undefined) notice.handle = handle
      // The card exactly as it went out — including the offer, if it was appended. A later rewrite
      // starts from this, because the one thing a rewrite cannot reconstruct is the card itself.
      //
      // Recorded **on the notice**, and only while the notice is still there: a card superseded
      // during its own delivery is a card nothing will ever rewrite, and giving it a view here is
      // precisely how the old second map leaked one card's whole text per occurrence. When the
      // notice is gone the view is not kept, because there is no longer anything that could ask for
      // it.
      if (notice !== undefined && handle !== undefined) notice[VIEW] = card
      // Remembered against the message as well, so a press that finds no live notice can
      // still be told which session the card belonged to — and so the next-task offer that rides
      // this card can name the workspace a new session would inherit. The session goes with it for
      // that second reason: the press carries the message and nothing else, and a task started
      // against the deployment's default directory is work in the wrong project.
      workspaces?.record(handle, workspace, session)
      log.info(messages().logNoticeSent)
      // The card is delivered, a press can find it, and this is the moment the phone has the
      // person's attention — so the moment to offer the one thing a result cannot: the next shard,
      // in a session of its own. It rides on this card (see `offer` above), so nothing more is sent
      // here; the view kept on the notice is what lets a later rewrite put the same card back
      // together.
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
  /**
   * The card one notice was sent as, taken off the notice that owns it.
   *
   * A rewrite is asked for by the message it came from, and the notice is what knows the message —
   * so this walks the live notices rather than keeping a second index beside them. The map holds the
   * sessions with an offer outstanding, which is a handful, and this runs once per press or per
   * retirement rather than per event.
   *
   * The ownership is not incidental: a view can only exist for a notice that is still live, so
   * there is no third state to keep consistent and nothing to clean up twice.
   * @param handle - the message the card lives in, as the channel reported it.
   * @returns the notice that owns that message and the card it was sent as, when both are known.
   */
  function cardOf(handle) {
    if (handle === undefined) return undefined
    for (const notice of notices.values()) {
      if (notice.handle !== handle) continue
      const view = notice[VIEW]
      if (view !== undefined) return { notice, view }
    }
    return undefined
  }

  /**
   * Take the reply control off a notice card that is no longer live.
   *
   * A notice card outlives the process that sent it: the map is in memory, so after a restart a
   * press found nothing and answered with a toast alone, leaving a card that still looked like it
   * would take a reply. The press carries the message it came from, so the card is rewritten where
   * it lies.
   *
   * Where this side still holds the card as sent, the *result* is kept and only the controls go.
   * The first version replaced the whole face with the headline, which took away the answer and the
   * run fold — the two things the reader came back to the card for — and left a sentence about why
   * the card no longer worked. A card whose reason is in doubt should still be readable. The
   * next-task offer goes with the controls for the same reason it does on a reply: its words without
   * its box are an instruction the reader cannot follow.
   * @param handle - the message the press came from, as the channel reported it.
   * @param headline - what the card says instead.
   * @param workspace - the label the card was sent with, so the rewrite agrees with it.
   */
  function retract(handle, headline, workspace) {
    if (handle === undefined || typeof channel.update !== 'function') return
    // A message the activity card is being shown in belongs to a run, not to a notice. This became
    // reachable the moment a reply turned the card it was made on into that run's card: a second
    // press on the same card — the one the reply came from — used to reach here with a rid that is
    // no longer live, and writing "this card no longer works" over it would replace a live run with
    // a sentence about a notice that is gone.
    if (activity?.owns?.(handle) === true) return
    const known = cardOf(handle)
    // With nothing appended, `RESULT_ENDS` is the end of the card and this keeps the whole face.
    const body = known === undefined
      ? [headline]
      : [...known.view.body.slice(0, known.view[RESULT_ENDS] ?? known.view.body.length), headline]
    void Promise.resolve(channel.update(handle, {
      title: titleOf(`${settings().titlePrefix} ${messages().resultTitle}`, workspace),
      tone: 'muted',
      body,
      buttons: [],
      forms: [],
      // Kept only when it is the card's own, so an unknown card is not given one by accident.
      ...(known?.view.details !== undefined ? { details: known.view.details } : {}),
    })).catch(error => { log.warn(messages().logNoticeCardFailed, error) })
  }

  /**
   * Close a card once a next task has been opened from it.
   *
   * The result stays — it is what the reader came back to — the fold stays, and every control goes:
   * a card whose offer has been taken must not leave a reply box that would hand the same session an
   * instruction aimed at an answer the reader has already moved past. The sentence that pointed at
   * that box goes with it, for the same reason.
   *
   * The offer module builds the closed card because the offer is its own: this side only supplies
   * the card as sent, which is the one thing the offer cannot see.
   * @param handle - the message the press came from.
   * @returns whether the card was rewritten.
   */
  async function aftermath(handle) {
    if (typeof channel.update !== 'function') return false
    const known = cardOf(handle)
    // No view means the card went out before this process existed (a restart) or was never sent. It
    // is then left exactly as it is: rewriting it would replace a result nobody here has a copy of
    // with a sentence about a task, which is a worse card than a stale one.
    if (known === undefined || typeof nextTask?.mergeInto !== 'function') return false
    const session = workspaces?.sessionOf?.(handle)
    const line = messages().workStarted(workspaceOf(session))
    // From the card as sent, not from the base result: the marker that says where the offer began
    // rides on the sent view, and without it the rewrite could not tell the offer from the answer.
    const closed = nextTask.mergeInto(known.view, session, line)
    // Taken off the notice it belongs to, so there is no second place that has to be told.
    delete known.notice[VIEW]
    try {
      await channel.update(handle, closed)
      return true
    } catch (error) {
      log.warn(messages().logNoticeCardFailed, error)
      return false
    }
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
      //
      // That is the whole of the desk-presence rule, and it rests on a field the harness never
      // promises — so it is the one mechanism here that can stop working without a symptom. The
      // counts below are how the *deployment* answers "is it still working", because from inside
      // this process a missing `rpcId` is indistinguishable from a person who is genuinely away:
      // both look like a human message with nothing beside it. There is deliberately no warning —
      // an absent marker is not evidence of a break, and crying wolf on every phone message would
      // be worse than the silence it replaced. What is here is the count, which turns "the phone
      // keeps interrupting me" into a fact that can be checked against it.
      if (typeof source.rpcId === 'string' && source.rpcId !== '') {
        humanWithRequestId += 1
        if (humanWithRequestId === 1) log.info(messages().logDeskSignalSeen(humanWithoutRequestId))
        priority?.set(PRIORITY_DESK)
      } else {
        humanWithoutRequestId += 1
        if (humanWithoutRequestId === 1) {
          // Said once, at the first human message of the process: if the deployment looks at the
          // desk and reads this, the rule is alive. If it never appears, nothing human has reached
          // this process directly — which is itself the answer to where the messages came from.
          log.info(messages().logDeskSignalAbsentSoFar)
        }
      }
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
  async function handleAction({ payload, values, messageId } = {}) {
    const id = typeof payload?.nid === 'string' ? payload.nid : undefined
    if (id === undefined) return undefined
    // Every way this can end without sending is said out loud from here on. The whole path used to be
    // silent until the very last branch, which meant "the reply did nothing" had no diagnostic at all
    // in the common case: the reader pressed, the plugin returned early, and nothing anywhere said
    // which of the five reasons it was.
    const notice = notices.get(id)
    if (notice === undefined) {
      // A press may only conclude that the notice is gone once this side has finished
      // looking. While the store is still opening, or a restore is still running, the
      // notice may be about to appear — and retiring the card then would throw away one
      // that is still valid, which is exactly what the durable record exists to prevent.
      // An early press therefore reports and changes nothing, leaving the card usable for
      // the moment the process can actually serve it.
      const settled = (store.isOpen() && restored) || store.unavailable()
      diagnostics(`回复：通知 ${id} 不在这张进程里（${settled ? '结论为已失效' : '还在等存储打开，不做结论'}）。`)
      if (settled) {
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
    if (text === '') {
      // The channel renames the control and reports the mapping back; a mismatch here is a card and a
      // decoder disagreeing about a name, which reaches the reader as a press that does nothing.
      diagnostics(`回复：表单里的文字没读到（控件映射=${JSON.stringify(payload?.submits ?? {})}，收到的值=${JSON.stringify(values ?? {})}）。`)
      return { toast: messages().emptyInstruction, accepted: false }
    }
    const agent = ctx.get?.('agents')?.get?.(notice.session)
    if (agent === undefined) {
      diagnostics(`回复：会话「${notice.session}」没有 agent，指令无处可去。`)
      return { toast: messages().noAgent, accepted: false }
    }
    // Claim before sending: the first submission wins and the rid dies here — durably
    // too, so that no later run can put the card back and take the reply twice.
    notices.delete(id)
    void store.remove(id)
    // Awaited, and its answer is the toast. The earlier version fired the send and returned
    // "已发送给 agent" immediately, so a reply that never reached the session was reported as sent:
    // the reader was told the next step had been handed over, stopped thinking about it, and the
    // instruction existed nowhere — the rid dead in memory *and* on disk, and the card already
    // rewritten to say it had arrived. The cost of awaiting is that this handler must stay inside
    // the platform's 3-second callback budget; the work is one dynamic import and one synchronous
    // hand-off, and a card rewrite that is slow is not waited on above.
    const delivered = await send(agent, text, notice)
    if (!delivered) {
      // Put the notice back so the card can be answered again. It is the honest state: the reply
      // was never taken, so the box on the card is still the way to send it. The window for a
      // second press is the send's own few milliseconds, and a duplicate press inside it would be
      // refused rather than answered twice — which is the right way round.
      noticeSet(id, notice)
      void store.put({
        rid: id,
        session: notice.session,
        handle: notice.handle,
        workspace: notice.workspace,
        seq: await sessionSeq(notice.session),
        sentAt: now(),
      }).then(() => { log.info(messages().logNoticeStored(id)) }).catch(() => {})
      return { toast: messages().notSent, accepted: false }
    }
    return { toast: messages().sent, accepted: true }
  }

  /**
   * Hand one instruction to the session, then record it on the notice's own message.
   *
   * The return value is the whole point: `true` only once the instruction has actually been given
   * to the agent. Everything after that — the card rewrite, the durable bookkeeping — is about a
   * card, not about the instruction, and a failure there must not be reported as a failure to send.
   * The caller answers the reader's toast on this value, so "the instruction did not go" and "the
   * card did not get rewritten" stay distinguishable.
   *
   * @param agent - the session's live agent.
   * @param text - what the reader typed.
   * @param notice - the notice the reply was made against.
   * @returns whether the instruction was queued in the session.
   */
  async function send(agent, text, notice) {
    try {
      // A reply typed on the phone is a person at the phone, so the head start stops
      // applying to whatever this session does next. Re-timed on the spot, so the calm
      // window of the turn this instruction starts is the short one.
      if (priority?.set(PRIORITY_PHONE) === true) rearm()
      // Imported here rather than at load: the message constructor lives in the
      // harness, and a deployment without it must still load this plugin. It can genuinely
      // reject — a deployment that cannot resolve the harness — which is why the failure below
      // is a real branch and not a formality.
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // Human input, minted by the surface the human is speaking through —
        // the same attribution the harness's own remote client gives a prompt
        // (`packages/acp/acp/src/session.ts`). A `{ kind: 'user' }` message is
        // what renders as the reader's own message in the Web flow and what
        // carries human authority; a plugin-sourced one renders as folded
        // injected context instead.
        source: { kind: 'user' },
      })
      // Which of the two doors this instruction goes through depends on whether the session is
      // already working, and the difference is not cosmetic: `followup` queues a turn of its own,
      // and on the real machine a follow-up queued against a **running** session was never
      // delivered — the notice was consumed, the card turned into a run, and no turn ever came of
      // it. Steering is the harness's own answer for a person speaking while it works: the running
      // driver consumes it at its next step boundary, and an idle one starts a turn. See issue #50.
      if (agent.status === 'running' && typeof agent.steer === 'function') {
        agent.steer(message)
        log.info(messages().logInstructionSteered)
        diagnostics(`回复：会话正在跑，指令以 steer 送进当前这一轮（消息 ${String(notice.handle ?? '')}）。`)
      } else {
        agent.followup(message)
        log.info(messages().logInstructionQueued)
      }
    } catch (error) {
      log.warn(messages().logInstructionFailed, error)
      return false
    }
    // Past this point the instruction is in the session; only the card is at risk. A failed
    // rewrite leaves a reply box on a card whose reply has already been taken, which is wrong but
    // recoverable by reading the conversation — and reporting it as "not sent" would be a worse
    // lie than the stale box.
    try {
      const sent = notice[VIEW]
      // The card the person just answered becomes the run's card, and this is the whole of the rule:
      // the card that moves is the card they touched. Leaving "已收到指令" on this one and opening a
      // second message somewhere else for the run that instruction starts is two cards for one
      // press, and the one that moves is not the one they are looking at.
      //
      // Asked before anything is read off the notice, because it needs nothing but the message the
      // reply came from — which is also the one case that had no rewrite at all until now: a notice
      // restored from the previous run carries no view here, so its card could not be rebuilt, and a
      // reply on it left the box the reader had just used sitting there.
      if (adoptCard(notice.session, notice.handle)) {
        log.info(messages().logReplyCardAdopted(String(notice.handle)))
      } else if (notice.session !== undefined && sent !== undefined) {
        // The fallback, for a deployment composed without the activity card: the card keeps the
        // answer and the fold, and loses the box it was answered through, so at least the reply
        // cannot be taken twice. Rebuilt from the card as sent, so nothing else drifts either.
        // Taken off the notice it belongs to, so there is no second place that has to be told.
        delete notice[VIEW]
        // Everything the offer appended goes with the controls it came with. Keeping the sentence
        // "或者，在新会话里开下一段" on a card whose box has just been removed is the same lie in a
        // quieter form: it points at a control that is not there. What stays is the result — the
        // answer and the run fold — and the line saying the instruction arrived.
        const ends = sent[RESULT_ENDS] ?? sent.body.length
        const body = [...sent.body.slice(0, ends), messages().received]
        await Promise.resolve(channel.update(notice.handle, {
          ...sent,
          title: titleOf(`${settings().titlePrefix} ${messages().resultTitle}`, notice.workspace),
          tone: 'success',
          body,
          forms: [],
        })).catch(error => { log.warn(messages().logNoticeCardFailed, error) })
        log.info(messages().logReplyCardRewritten(String(notice.handle)))
      } else {
        // Said out loud, because this branch used to be silent and the two ways it can end look
        // identical from the phone: a reply whose card is not rewritten is a card that still shows a
        // box the reader has already used. Which half is missing — the session or the card as sent —
        // is the whole diagnosis, and without this line the only symptom is "nothing changed", with
        // nothing anywhere to say whether a rewrite was attempted at all.
        log.warn(messages().logReplyCardNotRewritten({
          session: notice.session !== undefined,
          view: sent !== undefined,
          handle: String(notice.handle ?? ''),
        }))
      }
    } catch (error) {
      log.warn(messages().logNoticeCardFailed, error)
    }
    return true
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
     * Close a card whose next-task offer has been taken.
     *
     * Called by the offer's own module once the new session exists. It is this module's job because
     * only this side holds the card as sent — and a rewrite from the offer would have kept the offer
     * and dropped the result.
     * @param handle - the message the press came from.
     * @returns whether the card was rewritten.
     */
    aftermath,
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
