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

import { CARD_TEXT_BUDGET, clipToBytes, looksLikeSizeRefusal } from './budget.js'
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

/**
 * Watch root sessions, then offer each stopped session's answer to the channel.
 */
export function createResultNotifier({ ctx, log, channel, settings, messages, now = () => Date.now() }) {
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
   * Restart the quiet window. Any activity in the session calls this, so a run
   * of turns collapses into one notice after the last one stops.
   */
  const arm = (session) => {
    if (disposed) return
    const track = trackOf(session)
    if (track.timer !== undefined) clearTimeout(track.timer)
    track.timer = setTimeout(() => {
      track.timer = undefined
      // A throw here would be an uncaught exception, which the harness treats as
      // fatal: a notification must never be able to end the process.
      void fire(session).catch(error => { log.warn(messages().logNoticeFailed, error) })
    }, settings().delaySeconds * 1000)
    track.timer.unref?.()
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
    const view = {
      title: `${settings().titlePrefix} ${messages().resultTitle}`,
      tone: 'info',
      body: [answer, messages().replyHint],
      buttons: [],
      forms: [{ payload: { nid: id, submit: true }, fieldId: INSTRUCTION_FIELD, submitLabel: messages().sendToAgent }],
    }
    noticeSet(id, { session, handle: undefined })
    track.ended = undefined
    track.sentAt = now()
    try {
      const handle = await channel.deliver(view).catch(async (error) => {
        if (!looksLikeSizeRefusal(error)) throw error
        log.debug(messages().logNoticeTooLarge)
        answer = clipToBytes(track.message.text, messages().truncated, Math.floor(CARD_TEXT_BUDGET / 2))
        return await channel.deliver({ ...view, body: [answer, messages().replyHint] })
      })
      const notice = notices.get(id)
      if (notice !== undefined) notice.handle = handle
      log.info(messages().logNoticeSent)
      // Remembered only now: a card that never arrived has nothing to put back, and the
      // session's last seq is what a later run compares against to see whether the
      // session moved on while this process was not there to notice.
      void store.put({
        rid: id,
        session,
        handle,
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
      noticeSet(record.rid, { session: record.session, handle: record.handle })
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
    retract(record.handle, reason)
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
      retract(notice.handle, headline)
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
   */
  function retract(handle, headline) {
    if (handle === undefined || typeof channel.update !== 'function') return
    void Promise.resolve(channel.update(handle, {
      title: `${settings().titlePrefix} ${messages().resultTitle}`,
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
        // be showing the true reason, which "expired" would replace with a guess.
        retract(messageId, messages().noticeStale)
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
          title: `${settings().titlePrefix} ${messages().resultTitle}`,
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
