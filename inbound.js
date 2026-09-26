/**
 * What a typed message in the chat means, and what to say back.
 *
 * The card's input box is capped at 1000 characters by the platform — enough for a reply, not enough
 * for the first prompt of a new session — and typing in the chat beats filling in a form anyway. So a
 * message can carry an instruction, and the whole design rests on one anchor: **the platform sends
 * `parent_id` only when a message replies to another**, and it is that message's id. A card's id is
 * ours already, so "which card is this about" is a lookup we can always answer.
 *
 * Four rules decide everything else, and each one was chosen by the person who uses this:
 *
 * - **The quoted card decides what the message means.** A card that is still waiting for an answer — an
 *   approval, a question — makes this text that answer, and it is read as nothing else first. A question
 *   can ask for anything, including something that looks like a command or a prompt, so the card that
 *   asked is the only thing that can say what a reply to it is. This is also why the rule sits ahead of
 *   the commands below.
 * - **A message that quotes nothing is not acted on.** Guessing a session for it would be worse than
 *   doing nothing, because the instruction would land in the wrong conversation. It is not ignored in
 *   silence either — the reader gets one short hint, at most once every
 *   {@link HINT_INTERVAL_MS} per person.
 * - **Commands are the exception**, because their intent is in the word itself and there is nothing
 *   to guess: `/help` needs no card, and `/new <prompt>` needs one only to know which workspace the
 *   new session inherits ([0016](../docs/decisions/0016-the-phone-can-start-the-next-task.md)).
 * - **The card is the confirmation.** A quoted instruction that lands rewrites its card into the
 *   running card ([0021](../docs/decisions/0021-the-card-you-pressed-is-the-one-that-moves.md)), and a
 *   quoted answer rewrites its card into the decided one — which is the same thing a form reply or a
 *   button does. No extra message is sent for it, because this plugin's promise is that a round costs
 *   one message and not two.
 *
 * @module pocket-console/inbound
 */

/** How long one person is spared a second "I did not act on that" hint. */
export const HINT_INTERVAL_MS = 30_000

/**
 * Decide what one message means, without acting on it.
 *
 * Kept pure — the session is passed in as a lookup — so the rules can be read and tested on their
 * own, which is what the four branches below are for.
 * @param options - the message's text, the id it replies to, and how a replied-to id maps to a session.
 * @returns the action, with whatever the action needs.
 */
export function decideMessage({ text, parentId, sessionOf, requestAt = () => undefined }) {
  const trimmed = String(text ?? '').trim()
  // `/help` is answered wherever it is typed: it asks about the channel, not about a conversation.
  if (/^\/help\b/i.test(trimmed)) return { action: 'help' }
  const quoted = typeof parentId === 'string' && parentId !== '' ? parentId : undefined
  // **The quoted card decides what the message means.** A card that is waiting for an answer makes this
  // text that answer, and only then is it read as anything else — because a question can ask for
  // anything, including something that looks like a command or a prompt. That is also why this comes
  // before `/new`: a question about what a branch should be called has the answer `/new-parser`, and
  // `\b` stands between `w` and `-`, so the command would swallow it.
  const request = quoted === undefined ? undefined : requestAt(quoted)
  if (request !== undefined) {
    if (trimmed === '') return { action: 'hint', copy: 'hintEmpty' }
    return { action: 'answer', handle: quoted, kind: request, text: trimmed }
  }
  const quotedSession = quoted === undefined ? undefined : sessionOf(quoted)
  const newTask = /^\/new\b([\s\S]*)$/i.exec(trimmed)
  if (newTask !== null) {
    const prompt = newTask[1].trim()
    // `/new` with no prompt is a typo, not an empty session: starting one would burn a message and
    // produce a session with nothing to do.
    if (prompt === '') return { action: 'hint', copy: 'hintEmptyNew' }
    // `/new` without a quoted card cannot know which workspace to inherit, and choosing one for the
    // reader is exactly what this plugin does not do.
    if (quotedSession === undefined) return { action: 'hint', copy: 'hintOrphanNew' }
    return { action: 'new', session: quotedSession, prompt }
  }
  if (quotedSession !== undefined) {
    if (trimmed === '') return { action: 'hint', copy: 'hintEmpty' }
    return { action: 'reply', session: quotedSession, text: trimmed }
  }
  return { action: 'hint', copy: 'hintUnquoted' }
}

/**
 * Create the message side of the plugin.
 * @param options - the logger, the copy, `diagnostics`, the card registry, the result notifier, the
 *   next-task module, and the clock.
 * @returns handing one message over and answering with what to reply.
 */
export function createInbound({
  log, messages, diagnostics = () => {}, workspaces, results, work, escalation,
  now = () => Date.now(),
}) {
  /** When each person last got a hint, so a stream of unquoted messages is not a stream of replies. */
  const lastHint = new Map()

  /**
   * Whether this person may be told again that nothing happened.
   * @param sender - the bound recipient's open id.
   * @returns whether a hint is due.
   */
  const hintDue = (sender) => {
    const key = typeof sender === 'string' && sender !== '' ? sender : 'unknown'
    const at = now()
    const previous = lastHint.get(key)
    // Never hinted before is due; a window that has not passed is not. Treating "no entry" as the
    // epoch would swallow the first message, which is the one that most needs telling.
    if (previous !== undefined && previous + HINT_INTERVAL_MS > at) return false
    lastHint.set(key, at)
    return true
  }

  /**
   * Which session a quoted card belongs to, if we still know.
   *
   * Two sources, in this order: the in-memory registry every card is recorded in, then the durable
   * notice records, which is what makes a quoted card work across a restart.
   * @param handle - the message a card lives in.
   * @returns the session id, or undefined.
   */
  const sessionOfCard = (handle) => workspaces?.sessionOf?.(handle) ?? results?.sessionOfMessage?.(handle)

  /**
   * Whether the quoted card is a live request waiting to be answered.
   *
   * Asked of the escalation machine rather than tracked here, because it is the module that owns which
   * requests are still open — and because a card that is *not* one answers undefined, which is what
   * makes an ordinary result card read as an instruction. A quoted card that waits on an answer is read
   * first and answers first; see {@link decideMessage} for the order and why it is that order.
   * @param handle - the message a card lives in.
   * @returns the kind of request waiting there, or undefined when none is.
   */
  const requestKind = (handle) => escalation?.requestAt?.(handle)

  return {
    /**
     * Serve one typed message from the bound recipient.
     * @param message - what the channel reported: text, what it replies to, and the ids.
     * @returns what to say back, or nothing to say.
     */
    async handleMessage({ text = '', parentId, messageId, sender, messageType } = {}) {
      const session = parentId === undefined ? undefined : sessionOfCard(parentId)
      // Read before the text means anything: whether the quoted card is still waiting on an answer is
      // what decides whether this message *is* that answer or an instruction for a conversation.
      const request = requestKind(parentId)
      const decision = decideMessage({
        text,
        parentId,
        sessionOf: () => session,
        requestAt: () => request,
      })
      // The line that makes "my message did nothing" answerable: the shape of what arrived, and what
      // this side made of it. Lengths rather than text, and no ids, because a log is not a transcript.
      diagnostics(
        `收到消息：类型=${messageType ?? '未知'}，文本=${text.length} 字，引用=${parentId === undefined ? '无' : '有'}，`
        + `命中卡=${session === undefined ? '否' : '是'}，命中请求=${request ?? '无'}，`
        + `消息=${messageId === undefined ? '无 id' : '有 id'} → ${decision.action}`,
      )
      if (decision.action === 'help') return { reply: messages().helpText }
      if (decision.action === 'answer') {
        // Deliberately not awaited into anything slow: the whole answer is a decode and a hand-off, and
        // the card rewrite a decision triggers is started, not waited for (the press path's own
        // budget). Arriving *is* the confirmation — the quoted card turns into the decided one on its
        // own — so a success says nothing and only a refusal needs words.
        const outcome = escalation?.answerByHandle?.({ handle: decision.handle, text: decision.text })
        if (outcome?.ok === true) return undefined
        if (outcome?.reason === 'not-an-answer') return { reply: messages().messageNotAnAnswer(decision.kind) }
        if (outcome?.reason === 'empty') return { reply: messages().hintEmpty }
        // The request this card was waiting on is no longer open — answered at the desk, cancelled, or
        // gone with a restart. Nothing was decided, and saying so is the only honest reply.
        if (outcome?.reason === 'request-gone') return { reply: messages().messageAnswerGone }
        log.warn(messages().logMessageAnswerFailed, new Error(String(outcome?.reason ?? 'unknown')))
        return { reply: messages().messageAnswerGone }
      }
      if (decision.action === 'reply') {
        const outcome = await results.replyByHandle({ handle: parentId, text: decision.text })
        // Arriving is the confirmation, so a success says nothing: the card the reader quoted turns
        // into the running card on its own. Only a failure needs words.
        if (outcome?.ok === true) return undefined
        log.warn(messages().logInstructionFailed, new Error(String(outcome?.reason ?? 'unknown')))
        return { reply: messages().messageReplyFailed(outcome?.reason) }
      }
      if (decision.action === 'new') {
        const started = await work.startFromMessage(decision.session, decision.prompt).catch((error) => {
          log.warn(messages().logMessageNewFailed, error)
          return undefined
        })
        if (started === undefined) return { reply: messages().messageNewFailed }
        return undefined
      }
      // A hint is a courtesy, not a service: at most one per person per window, so an experimental
      // sender cannot turn this channel into a reply loop.
      return hintDue(sender) ? { reply: messages()[decision.copy] } : undefined
    },
  }
}
