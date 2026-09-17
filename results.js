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
  let installed = false

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
    if (!installed) return
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
    } catch (error) {
      notices.delete(id)
      log.warn(messages().logNoticeSendFailed, error)
    }
  }

  /** Record one notice; the map is the rid's whole validity window. */
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
      retired += 1
      if (notice.handle === undefined) continue
      void Promise.resolve(channel.update(notice.handle, {
        title: `${settings().titlePrefix} ${messages().resultTitle}`,
        tone: 'muted',
        body: [headline],
        buttons: [],
        forms: [],
      })).catch(error => { log.warn(messages().logNoticeCardFailed, error) })
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
   * @param payload - the button or form payload the channel echoed.
   * @param values - submitted form values.
   * @returns the channel's toast response, or undefined.
   */
  function handleAction(payload, values) {
    const id = typeof payload?.nid === 'string' ? payload.nid : undefined
    if (id === undefined) return undefined
    const notice = notices.get(id)
    if (notice === undefined) return { toast: messages().noticeGone, accepted: false }
    const text = typeof values?.[INSTRUCTION_FIELD] === 'string' ? values[INSTRUCTION_FIELD].trim() : ''
    if (text === '') return { toast: messages().emptyInstruction, accepted: false }
    const agent = ctx.get?.('agents')?.get?.(notice.session)
    if (agent === undefined) {
      return { toast: messages().noAgent, accepted: false }
    }
    // Claim before sending: the first submission wins and the rid dies here.
    notices.delete(id)
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
      installed = true
      const off = ctx.on('session/event', onEvent)
      return () => {
        installed = false
        off()
        for (const track of tracks.values()) {
          if (track.timer !== undefined) clearTimeout(track.timer)
        }
        tracks.clear()
        notices.clear()
      }
    },
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
