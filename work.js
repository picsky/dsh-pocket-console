/**
 * Starting a new task from the phone, in the workspace the current session already has.
 *
 * The phone's job in this plugin is to *advance* work, not to be a port of the desk. Everything
 * else it does answers something the desk started: an approval, a question, the next instruction
 * for a session that just stopped. The one thing a plan cannot leave to the desk is the next shard
 * — by the time a long run finishes, the person is away from it, and "start the next part" is
 * exactly the decision that arrives while they are away.
 *
 * So this is the narrowest form of that: **a new session, in the workspace the session you are
 * looking at already uses, with the deployment's model**. It cannot choose a workspace, cannot
 * reach another project, and cannot touch settings or credentials. What it does do is genuinely
 * larger than answering a card — it starts work rather than deciding it — and the README and
 * SECURITY.md say so rather than pretending the old blast radius still holds.
 *
 * Two properties are load-bearing and easy to get wrong:
 *
 * - **The prompt goes through the agent, not the session controller.** The controller's `prompt()`
 *   stamps the caller's request id onto the message source, which is exactly the mark the result
 *   notifier reads as "somebody typed at the desk" (see
 *   [0015](../../docs/decisions/0015-desk-presence-is-the-gateways-request-id.md)). A task started
 *   from the phone would then hand the head start back to the desk and undo phone priority. An
 *   `agent.followup()` with a plain `{ kind: 'user' }` source is what the result card already uses.
 * - **The workspace comes from the session the press was made against**, never from the press. A
 *   card is a credential for one decision; letting it name a directory would turn a lost phone into
 *   a way to run work anywhere on the machine.
 *
 * @module pocket-console/work
 */

import { titleOf, workspaceLabel } from './identity.js'
import { PHONE } from './priority.js'

/** The payload key that marks a press as "start a new task" rather than an answer to a request. */
export const WORK_START = 'work-start'

/** The form control the new task's text arrives in. */
export const WORK_FIELD = 'workText'

/**
 * Create the new-task card and the action behind it.
 * @param options - the host context, the logger, the channel, the settings, the copy, the workspace
 *   registry delivered cards are remembered in, and the priority state a started task moves.
 * @returns the card's view, and the handler for its press.
 */
export function createWork({ ctx, log, channel, settings, messages, workspaces, priority }) {
  /**
   * The view that offers to start a new task in a session's workspace.
   * @param session - the session whose workspace would be inherited, when it is known.
   * @returns the channel-neutral view.
   */
  const viewFor = (session) => {
    const copy = messages()
    const workspace = workspaceLabel(ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd)
    return {
      title: titleOf(`${settings().titlePrefix} ${copy.workTitle}`, workspace),
      tone: 'info',
      body: [copy.workIntro],
      buttons: [],
      forms: [{
        payload: { work: WORK_START },
        fieldId: WORK_FIELD,
        submitLabel: copy.workStart,
      }],
    }
  }

  /** The workspace label of a session, as every card names it. */
  const workspaceOf = (session) => workspaceLabel(
    ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd,
  )

  /**
   * Start the session and hand it the first prompt.
   * @param session - the session whose workspace the new one inherits.
   * @param text - what the person asked the new session to do.
   * @returns the new session's id, or undefined when it could not be started.
   */
  const start = async (session, text) => {
    const controller = ctx.get?.('sessionController')
    if (typeof controller?.create !== 'function') {
      log.warn(messages().noSessionController)
      return undefined
    }
    const cwd = ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      // Without a workspace there is nothing to inherit, and a session created against whatever
      // the deployment's default directory happens to be is not what the card offered.
      log.warn(messages().logWorkFailed, new Error('the asking session names no workspace'))
      return undefined
    }

    const { sessionId } = await controller.create({ cwd })
    const agent = ctx.get?.('agents')?.get?.(sessionId)
    if (typeof agent?.followup !== 'function') {
      log.warn(messages().logWorkFailed, new Error(`session "${String(sessionId)}" has no agent`))
      return undefined
    }
    // Imported here rather than at load, the way the result card's reply does it: the message
    // constructor lives in the harness, and a deployment without it must still load this plugin.
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      // Human input, minted by the surface the human is speaking through — and deliberately
      // without a gateway request id, which is what keeps it from reading as a person at the desk.
      source: { kind: 'user' },
    }))
    log.info(messages().logWorkStarted(String(sessionId), workspaceOf(sessionId) ?? workspaceLabel(cwd)))
    return sessionId
  }

  return {
    /**
     * Put the new-task card on the phone for one session.
     *
     * Only while the phone holds the person, which is the same rule the activity card follows: what
     * a run is doing, and what could come next, are things the desk can already see. A card sent
     * while somebody is sitting at the desk is a message nobody asked for — and a person reading
     * this plugin's promise would be right to call it push.
     * @param session - the session whose workspace would be inherited.
     * @returns the delivered message handle, or undefined when nothing was sent.
     */
    async offer(session) {
      if (typeof channel.deliver !== 'function') return undefined
      if (priority?.get?.() !== PHONE) return undefined
      try {
        const handle = await channel.deliver(viewFor(session))
        // Recorded against the message so the press, which carries only the message, can find the
        // session whose workspace it inherits. This is the reason the registry carries a session.
        workspaces?.record(handle, workspaceOf(session), session)
        return handle
      } catch (error) {
        log.warn(messages().logWorkFailed, error)
        return undefined
      }
    },

    /**
     * Answer one press or form submission from a new-task card.
     * @param action - what the channel reported: the echoed payload, the values, and the message.
     * @returns the channel's toast response, or undefined when the action is not this module's.
     */
    async handleAction({ payload, values, messageId } = {}) {
      if (payload?.work !== WORK_START) return undefined
      const copy = messages()
      // The channel names its own controls and reports the mapping back, so the value is read
      // through `submits` and never from the field name directly: a channel that renamed the
      // control — which the Feishu one does, to keep two forms on one card from colliding — would
      // otherwise deliver an empty instruction for a form the reader filled in.
      const submitted = values?.[payload?.submits?.[WORK_FIELD] ?? WORK_FIELD]
      const text = typeof submitted === 'string' ? submitted.trim() : ''
      if (text === '') return { toast: copy.emptyInstruction, accepted: false }

      // The session is read from the message the press came from, not from the payload: a press is
      // the only thing that proves this card is being answered, and the card is what names the
      // workspace.
      const session = workspaces?.sessionOf?.(messageId)
      const started = await start(session, text).catch((error) => {
        log.warn(messages().logWorkFailed, error)
        return undefined
      })
      if (started === undefined) return { toast: copy.noSessionController, accepted: false }

      // The card stops offering, because it has been used. Left as a form it would invite a second
      // press that starts a second session for the same text.
      if (messageId !== undefined && typeof channel.update === 'function') {
        const workspace = workspaceOf(session)
        void Promise.resolve(channel.update(messageId, {
          title: titleOf(`${settings().titlePrefix} ${copy.workTitle}`, workspace),
          tone: 'success',
          body: [copy.workStarted(workspace)],
          buttons: [],
          forms: [],
        })).catch(error => { log.warn(copy.logMessageRewriteFailed, error) })
      }
      // The person is holding the phone, so the session they just started should not wait out a
      // desk head start — the same reason a card answer moves the side.
      priority?.set?.(PHONE)
      return { toast: copy.sent, accepted: true }
    },
  }
}
