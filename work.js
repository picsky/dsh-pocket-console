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
 * A third one is invisible from here and was learned the hard way: **the new session has to be
 * created *through* its workspace, not with a bare directory.** A session appears under a project in
 * the Web interface because that workspace's account names it, and the account is written only on
 * `create`'s `workspaceId` branch. Creating with a `cwd` produced a task that ran, reported to the
 * phone, and sat under "ungrouped" at the desk — see
 * [0020](../../docs/decisions/0020-a-phone-started-session-joins-its-workspace.md) and
 * `tests/work-workspace.test.mjs`, which asserts the request shape rather than the outcome, because
 * the request is the whole of it.
 *
 * @module pocket-console/work
 */

import { workspaceLabel } from './identity.js'
import { PHONE } from './priority.js'

/** The payload key that marks a press as "start a new task" rather than an answer to a request. */
export const WORK_START = 'work-start'

/** The form control the new task's text arrives in. */
export const WORK_FIELD = 'workText'

/**
 * How many cards are remembered as "this one already started a session".
 *
 * A press that starts a second session for the same text is the one outcome the card must not
 * allow, and the card's own face cannot be the guard: the platform may keep showing a form on a
 * card this plugin has already rewritten. Remembering the message is what makes the second press
 * a no-op, and the bound keeps the memory from growing with the session's history.
 */
const USED_CAPACITY = 64

/**
 * Create the new-task card and the action behind it.
 * @param options - the host context, the logger, the channel, the settings, the copy, the workspace
 *   registry delivered cards are remembered in, and the priority state a started task moves.
 * @returns the card's view, and the handler for its press.
 */
export function createWork({ ctx, log, channel, settings, messages, workspaces, priority }) {
  /** Messages whose offer has already been used, oldest first, so a second press starts nothing. */
  const used = new Set()

  /** Remember one message as used, evicting the oldest once the bound is reached. */
  const markUsed = (messageId) => {
    if (messageId === undefined) return
    if (used.size >= USED_CAPACITY) used.delete(used.values().next().value)
    used.add(messageId)
  }

  /** The one control this module owns: a box for the next task's text, and the press that sends it. */
  const formOf = (copy) => ({
    payload: { work: WORK_START },
    fieldId: WORK_FIELD,
    submitLabel: copy.workStart,
    // Its own placeholder, because this box shares a card with the reply box: two empty inputs
    // labelled the same way would leave the reader guessing which one starts a session and which
    // one answers the session they are looking at.
    placeholder: copy.workPlaceholder,
  })

  /** The workspace label of a session, as every card names it. */
  const workspaceOf = (session) => workspaceLabel(
    ctx.get?.('agents')?.get?.(session)?.session?.header?.cwd,
  )

  /**
   * The sentence that offers the next task, and the control that sends it.
   *
   * The offer rides on the result card now, so this is built to be *appended* to a view this module
   * does not own: the sentence goes on the body, the form on the form list. A result already ends on
   * "what now?", and a second card asking that question was one more notification for one run — the
   * cost this plugin keeps counting. The channel namespaces the controls of two forms on one card,
   * and the core already ships questions with two controls, so both forms can share a face.
   *
   * @returns the sentence to append, and the form to add.
   */
  const nextTask = () => ({ intro: messages().workIntro, form: formOf(messages()) })

  /**
   * Where on a view the offer began.
   *
   * Recorded on the view itself, because a card carrying this offer is rewritten later — when a
   * task is opened from it — and that rewrite has to take the offer back off. Without a marker the
   * rewrite would have to guess which paragraphs were the offer, and guessing is how a card ends up
   * either repeating the offer or eating part of the answer.
   */
  const OFFER_FROM = 'offerFrom'

  /**
   * Put the next-task offer onto a card that is already going out.
   *
   * Two shapes come out of this, and they are the same card at two moments. With no `outcome` it is
   * the offer: the result, the sentence that asks for the next task, and the box to type it in.
   * With `outcome` it is the aftermath: the same result, every control gone, and one line saying
   * what was opened.
   *
   * The result is carried through both times on purpose. This card is the answer the reader came
   * for, and a card that dropped it to say "新会话已开始" would have thrown away the only copy of
   * the thing it was reporting on. For the same reason the fold is kept: it is the run that
   * produced the answer.
   *
   * The title is left exactly as the caller built it. This module used to recompute it from the
   * session, which named the same workspace a second time and did it by *re-reading* the session —
   * the thing `identity.js` says never to do on a rewrite, because a session reclaimed in between
   * names nothing and the label would vanish from the card that already carried it. The caller sets
   * the title once, when it builds the card, and a rewrite now inherits it.
   *
   * @param view - the result's view, which is not mutated.
   * @param session - the session whose workspace a new task would inherit.
   * @param outcome - the line to close with, once a card has been used, instead of the offer.
   * @returns the view to write.
   */
  const mergeInto = (view, session, outcome) => {
    const copy = messages()
    // Taken off whichever view is handed over: on the aftermath pass this is the card as sent,
    // which still carries the marker.
    const from = view[OFFER_FROM]
    const base = { ...view }
    delete base[OFFER_FROM]
    if (outcome !== undefined) {
      // Every control goes, not just this module's: a card whose offer has been taken must not
      // leave a reply box that would hand the same session an instruction the reader never meant
      // to send against an answer they have moved past.
      //
      // The face is rebuilt rather than appended to. `view` is the card as it was sent, so it still
      // carries the sentence that pointed at the reply box and the two paragraphs of the offer;
      // appending the outcome to that would repeat the offer and leave the reader told to reply to
      // a box that is gone. Both entries sit at a known place — the hint is second, `offerFrom` is
      // where the offer began — and everything before the hint is the result, which is what stays.
      const hint = messages().replyHint
      const from = view[OFFER_FROM]
      const kept = (from === undefined ? view.body : view.body.slice(0, from))
        .filter(part => part !== hint)
      return { ...base, body: [...kept, outcome], forms: [], buttons: [] }
    }
    const { intro, form } = nextTask()
    return {
      ...base,
      body: [...view.body, copy.workOfferHint, intro],
      forms: [...(view.forms ?? []), form],
      // Where the offer began, so a later rewrite can take it back off without guessing.
      [OFFER_FROM]: view.body.length,
    }
  }

  /**
   * Give the new session its first prompt.
   *
   * Imported here rather than at load, the way the result card's reply does it: the message
   * constructor lives in the harness, and a deployment without it must still load this plugin.
   * @param sessionId - the session that was just created.
   * @param text - what the person asked it to do.
   * @returns whether the prompt was handed over.
   */
  const prompt = async (sessionId, text) => {
    const agent = ctx.get?.('agents')?.get?.(sessionId)
    if (typeof agent?.followup !== 'function') return false
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      // Human input, minted by the surface the human is speaking through — and deliberately
      // without a gateway request id, which is what keeps it from reading as a person at the desk.
      source: { kind: 'user' },
    }))
    return true
  }

  /**
   * Start the session and hand it the first prompt.
   *
   * **The new session is created through the workspace, not through a bare directory.** A session
   * is grouped in the Web interface because a workspace's `sessionIds` account names it, and the
   * account is only written when creation names a workspace: `sessionController.create` attaches the
   * session *solely* on the `workspaceId` branch, and treats `cwd` as the fallback for a session that
   * belongs to no group. Creating with a bare `cwd` therefore produced a session that ran correctly
   * and was reachable from the phone while sitting under "ungrouped" at the desk — reported from a
   * real deployment, and reproduced in its stored data: a session whose header cwd was a registered
   * workspace and whose id was in no workspace's account.
   *
   * The workspace is resolved from the asking session's own directory, so the inheritance the card
   * promised is unchanged; it is named the way the registry names it rather than the way a string
   * happens to be spelled. When it cannot be resolved — a deployment composing no workspace
   * registry, or a directory that no longer exists — the start falls back to the bare directory
   * rather than failing: a task that runs ungrouped is worth more than a card that does nothing, and
   * the deployment log says which one happened so the next report needs no guessing.
   *
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

    let created
    const registry = ctx.get?.('workspaceRegistry')
    if (typeof registry?.resolveByPath === 'function') {
      try {
        // Resolved first, then handed to creation: an ungrouped session cannot be repaired by
        // attaching it afterwards, because membership also requires the stored header's cwd to equal
        // the workspace path, and creation is what writes that header.
        const workspace = await registry.resolveByPath(cwd)
        if (workspace === undefined) {
          // The directory exists (or `resolveByPath` would have refused) but nothing owns it, so it
          // has no group on the desk to join. A session created here is *not* chased into a new
          // workspace record: this module's one write is the session it was asked to start, and
          // inventing a registry entry from a phone press is a larger act than the card promised.
          log.warn(messages().logWorkUnowned(cwd))
        }
        created = await controller.create(
          workspace === undefined ? { cwd } : { workspaceId: workspace.id },
        )
      } catch (error) {
        // Either the lookup refused (the directory does not resolve) or creation did. Creation fails
        // *after* the session exists, so this is the branch that keeps a half-started task from
        // leaving a card that says "已开新会话" with nothing behind it.
        log.warn(messages().logWorkUngrouped, error)
        created = await controller.create({ cwd })
      }
    } else {
      created = await controller.create({ cwd })
    }

    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      // A controller that answered without an id leaves nothing to prompt or to name, and saying so
      // is not the same as blaming the agent for a session that was never handed over.
      log.warn(messages().logWorkFailed, new Error('session creation returned no id'))
      return undefined
    }
    if (await prompt(sessionId, text) === false) {
      log.warn(messages().logWorkFailed, new Error(`session "${sessionId}" has no agent`))
      return undefined
    }
    log.info(messages().logWorkStarted(String(sessionId), workspaceOf(sessionId) ?? workspaceLabel(cwd)))
    return sessionId
  }

  return {
    /**
     * Answer one press or form submission from a new-task card.
     * @param action - what the channel reported: the echoed payload, the values, and the message.
     * @param aftermath - called with the message once the session exists, so whoever owns that card
     *   can rewrite it. The card is not rewritten here: this module knows what it added, not what
     *   the card already carried, and a rewrite from here would drop the result it was riding on.
     * @returns the channel's toast response, or undefined when the action is not this module's.
     */
    async handleAction({ payload, values, messageId } = {}, aftermath) {
      if (payload?.work !== WORK_START) return undefined
      const copy = messages()
      // The platform may keep showing a form on a card this side has already rewritten, so the
      // face is not the guard — the message is. Without this the same text starts two sessions.
      if (messageId !== undefined && used.has(messageId)) {
        return { toast: copy.workAlreadyStarted, accepted: false }
      }
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

      markUsed(messageId)
      await aftermath?.(messageId)
      // The person is holding the phone, so the session they just started should not wait out a
      // desk head start — the same reason a card answer moves the side.
      priority?.set?.(PHONE)
      return { toast: copy.sent, accepted: true }
    },

    /**
     * Append the offer to a card somebody else is about to send.
     *
     * The result card is where this belongs now. A result already asks "what next?", and answering
     * it with a second card cost one more notification for the same run — the cost this plugin
     * spends the most care on. This is the whole of what the module contributes to that card.
     * @param view - the result's view, or the card as it was sent when closing one.
     * @param session - the session whose workspace a new task would inherit.
     * @param outcome - the line to close with, once a card's offer has been taken.
     * @returns the view to send.
     */
    mergeInto(view, session, outcome) {
      return mergeInto(view, session, outcome)
    },
  }
}
