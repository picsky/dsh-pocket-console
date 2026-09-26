/**
 * The escalation lifecycle.
 *
 * An approval or a question is a waterfall: the desktop's own answerer sits
 * behind this listener, and whichever side answers first settles the request. A
 * request is offered to the phone only after the desktop has had its window, and
 * only when the channel can actually deliver — otherwise the desktop chain stays
 * authoritative and nothing waits on a message that will never arrive.
 *
 * This module owns the timer, the race, the pending registry, the rendered
 * views, and the two decoders that turn a phone action into an answer. A typed
 * message that quotes one of these cards is answered through the same two
 * decoders: the card names the request, and the text becomes the payload a
 * press would have carried.
 *
 * @module pocket-console/escalation
 */

import { CARD_TEXT_BUDGET, classifyRefusal, clipToBytes, flattenViewTables } from './budget.js'
import { titleOf, workspaceLabel } from './identity.js'
import { DESK, PHONE, shouldReturnHeadStart } from './priority.js'

import { randomUUID } from 'node:crypto'

/** Approval outcome meaning "this one call may proceed". */
const ALLOW = 'allowed-once'
/** Approval outcome meaning "do not proceed". */
const REJECT = 'rejected'
/** Approval outcome meaning "do not ask again in this session": switch it to full access, and grant
 * this one call too, because the person pressing it plainly wants this one to go through. */
const ALLOW_FULL = 'allowed-full'

/**
 * The words a typed answer to an approval card accepts, and the outcome each one means.
 *
 * Deliberately tiny, and deliberately exact. A tool grant is not a conversation: `ok`, `yes`, `好`,
 * `行`, every prefix and every near miss are refused, because refusing a word somebody meant costs one
 * more message while accepting one they did not costs a tool call nobody authorized. The refusal says
 * which two words work.
 *
 * Both languages are always accepted, whichever language the card is written in: a person types what
 * they think, and a rule they cannot see — that the Chinese word works only on a Chinese card — is a
 * rule they cannot learn.
 *
 * The full-access switch is **not** here and must never be. It changes a session's policy rather than
 * answering the request in front of the reader, and the card makes it pass a platform confirmation
 * first; a word typed into a chat must not do what a deliberate press cannot.
 */
const APPROVAL_WORDS = new Map([
  ['允许', ALLOW],
  ['allow', ALLOW],
  ['拒绝', REJECT],
  ['reject', REJECT],
])

/**
 * What a typed answer to an approval card means.
 *
 * Exported rather than kept in the closure so the accepted set can be read — and tested — on its own:
 * the reachable outcomes are exactly the two values in the table above, which is the property that
 * keeps a typed answer from ever producing a third one.
 * @param text - what the reader typed.
 * @returns the outcome, or undefined when the text is not one of the accepted words.
 */
export function approvalOutcomeFor(text) {
  return APPROVAL_WORDS.get(String(text ?? '').trim().toLowerCase())
}

/** Form field carrying the chosen options, or the typed answer when none are offered. */
const FORM_VALUE_FIELD = 'value'
/** Form field carrying a typed answer beside a multi-select's options. */
const FORM_CUSTOM_FIELD = 'custom'

/** How long one delivery retry waits before trying again. */
const DELIVERY_RETRY_MS = 5_000
/** How many attempts one card gets before the escalation is given up on. */
const DELIVERY_MAX_TRIES = 4
/** How long one post-decision rewrite retry waits. */
const REWRITE_RETRY_MS = 1_000
/** How many attempts a post-decision rewrite gets before it is given up on. */
const REWRITE_MAX_TRIES = 3

/** Wait, without holding the process open for it. */
const sleep = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds)
  timer.unref?.()
})

/**
 * What one card title calls the request it belongs to.
 *
 * The kind alone was enough while one card was on screen at a time; with several
 * sessions running it is not, so the session's workspace is named beside it. See
 * {@link workspaceLabel} for what counts as a name.
 * @param settings - the effective settings.
 * @param workspace - the session's label, when it has one.
 * @param kind - what this card is asking for.
 * @returns the title for the channel.
 */
const titleFor = (settings, workspace, kind) => titleOf(`${settings.titlePrefix} ${kind}`, workspace)

/**
 * Create the escalation state machine.
 * @param options - the logger, the channel, the settings, mirror, and copy
 *   thunks, whether the channel is closed for new work, and the session names.
 * @returns the answerer, the action router, the pending report, and disposal.
 */
export function createEscalation({
  log, channel, settings, mirror, messages, workspaces, priority, sessionNames,
  diagnostics = () => {},
  // The permission presets, when the host composes them. The default reports "no full access", which
  // is what an older host is: the approval card then has the two buttons it has always had.
  permissions = { fullAccess: () => undefined, current: () => undefined, set: () => false },
}) {
  /** Live escalations keyed by the opaque id embedded in their action payloads. */
  const open = new Map()
  /**
   * Live escalations keyed by the message their card was delivered into.
   *
   * The id inside a payload is what a press carries, and it is this registry's only key — but a typed
   * message carries no payload at all, only the message it quotes. So an answer that arrives as text
   * needs the other direction, and this is it: written when the card lands, dropped by {@link release}
   * along with everything else the record holds. That is what makes a text answer able to reach only a
   * request that is still waiting, and nothing here is persisted, for the same reason nothing else is:
   * the desktop branch is what remains authoritative after a restart, and a text answer to a request
   * this process no longer knows is answered with a hint rather than a guess.
   */
  const byHandle = new Map()
  /** Set by close(): an escalation started after disposal must not arm a timer. */
  let closed = false

  /**
   * The small line under the title, naming the session this request came from.
   *
   * Read at render time rather than copied onto the record, because a session's title can arrive
   * after the request does — the generator is asynchronous — and a card that is still being
   * rewritten should pick the name up rather than keep the blank it started with. Absent means the
   * header is exactly what it was before this line existed.
   * @param session - the session id the request came from.
   * @returns the line, or undefined.
   */
  const subtitleFor = (session) => sessionNames?.subtitle?.(session)

  /**
   * The wait in force: the configured head start, or none while the phone has the person.
   *
   * Resolved here rather than at each timer, so no timer has to know which side the person
   * is on — and so a deployment composed without the priority machine keeps the setting.
   */
  const effectiveDelay = () => priority?.delaySeconds() ?? settings().delaySeconds

  /**
   * Bound text to what one card may carry.
   *
   * A plan review or a long reason otherwise overflows a channel's message limit,
   * and the budget is in bytes because a CJK character costs three of them.
   * @param value - untrusted text from the request.
   * @param budget - the byte budget, halved when a delivery is retried.
   * @returns the text, clipped with a marker when it did not fit.
   */
  const clip = (value, budget = CARD_TEXT_BUDGET) => clipToBytes(value, messages().truncated, budget)

  /** Whether this request can be fully answered from a channel message. */
  const escalatable = (kind, request) => {
    if (kind === 'approval') return true
    if (channel.supportsForms === true) return true
    // Without form support only single-select option questions are answerable,
    // and a partially answerable request would strand its remaining questions.
    return request.questions.every(question =>
      (question.options ?? []).length > 0 && question.multiSelect !== true)
  }

  /**
   * Render one request as a channel-neutral message.
   * @param record - the live escalation.
   * @returns the view handed to the channel.
   */
  const buildView = (record, budget = CARD_TEXT_BUDGET) => {
    const copy = messages()
    if (record.kind === 'approval') {
      const { toolName, callId, reason } = record.request
      const body = [copy.toolLabel(toolName)]
      if (callId !== undefined) body.push(copy.callIdLabel(callId))
      if (reason !== undefined && reason !== '') body.push(copy.reasonLabel(clip(reason, budget)))
      body.push(effectiveDelay() === 0
        ? copy.approvalLive
        : copy.approvalUpgraded(effectiveDelay()))
      return {
        title: titleFor(settings(), record.workspace, copy.approvalTitle),
        subtitle: subtitleFor(record.session),
        tone: 'warning',
        body,
        buttons: [
          { payload: { rid: record.id, v: ALLOW }, label: copy.allowOnce, tone: 'primary' },
          { payload: { rid: record.id, v: REJECT }, label: copy.reject, tone: 'danger' },
          // The third control, and only when the deployment actually offers a full-access preset:
          // on a host without one there is nothing to switch to, and a button that cannot do what it
          // says is worse than a card with two of them.
          ...(permissions.fullAccess() === undefined
            ? []
            : [{
                payload: { rid: record.id, v: ALLOW_FULL },
                label: copy.allowFullAccess(permissions.fullAccess().label),
                // `default` rather than `primary_filled`: this is not the pressing the card is for,
                // and a privilege change should not be the most inviting thing on it.
                tone: 'default',
                // The desktop asks for a risk acknowledgement before a visible switch to full access;
                // a plugin calling the setter would step over it. This is that step, moved to where
                // the press happens, so the person who decides is the person who reads the warning.
                confirm: { title: copy.fullAccessConfirmTitle, text: copy.fullAccessConfirmText },
              }]),
        ],
        forms: [],
      }
    }

    const questions = record.request.questions
    const recorded = record.answers
    const body = []
    const buttons = []
    const forms = []
    // More than one question is the only case where progress is not obvious.
    if (questions.length > 1) {
      body.push(copy.progress(recorded.size, questions.length))
    }
    // An answered question keeps its place as a record of what is already decided,
    // and loses its controls.
    for (const question of questions) {
      const answer = recorded.get(question.id)
      if (answer === undefined) continue
      body.push([
        question.header === undefined ? '' : `**${question.header}**`,
        question.question,
        `✅ ${answer.custom ?? answer.selected.join(copy.selectionSeparator)}`,
      ].filter(Boolean).join('\n\n'))
    }

    // One question is asked at a time, and answering it rewrites the card to the next.
    //
    // A card is a flat document with the text blocks first and the controls after
    // them, so a card carrying several questions renders every question's text and
    // then every question's buttons: the reader cannot tell which button answers
    // which question, and two identical `submitOther` forms are indistinguishable.
    // Asking one question per card is also the rhythm the desktop composer already
    // steps through, so both surfaces walk the same request the same way.
    const current = questions.find(question => !recorded.has(question.id))
    const position = current === undefined ? 1 : questions.indexOf(current) + 1
    if (current !== undefined) {
      const heading = current.header === undefined ? '' : `**${current.header}**`
      body.push([
        heading,
        current.question,
        current.detail === undefined ? '' : clip(current.detail, budget),
      ].filter(Boolean).join('\n\n'))

      const options = current.options ?? []
      // A button label carries no room for an option's description, so the
      // body holds the legend and the buttons stay the answer controls.
      if (options.some(option => option.description !== undefined && option.description !== '')) {
        body.push([copy.optionsLegend, ...options.map((option, index) => {
          const description = option.description === undefined || option.description === ''
            ? ''
            : ` — ${clip(option.description, budget)}`
          return `${index + 1}. **${option.label}**${description}`
        })].join('\n'))
      }
      if (options.length === 0 || current.multiSelect === true) {
        forms.push({
          payload: { rid: record.id, q: current.id, submit: true },
          fieldId: FORM_VALUE_FIELD,
          ...(options.length === 0
            ? {}
            : {
                options: options.map(option => ({ label: option.label, value: option.label })),
                // A multi-select answer may carry text beside its choices, so
                // the form offers the second control the desktop card shows.
                customFieldId: FORM_CUSTOM_FIELD,
              }),
          multiSelect: current.multiSelect === true,
          submitLabel: copy.submitAnswer,
        })
      } else {
        for (const option of options) {
          buttons.push({
            payload: { rid: record.id, q: current.id, v: option.label },
            label: option.label,
            tone: 'default',
          })
        }
        // The desktop card always accepts a typed answer beside its options, so
        // the phone needs the same door; a single-select typed answer carries the
        // text alone, with no option selected.
        forms.push({
          payload: { rid: record.id, q: current.id, submit: true },
          fieldId: FORM_VALUE_FIELD,
          submitLabel: copy.submitOther,
        })
      }
    }
    return {
      // Which question this is, so a card that has moved on says where the reader
      // is. One question needs no position: the title would only repeat itself.
      title: questions.length > 1
        ? titleFor(settings(), record.workspace, copy.questionOf(position, questions.length))
        : titleFor(settings(), record.workspace, copy.questionTitle),
      subtitle: subtitleFor(record.session),
      tone: 'info',
      body,
      buttons,
      forms,
    }
  }

  /** The terminal view shown once a request has been decided. */
  const settledView = (record, headline, tone) => ({
    title: titleFor(
      settings(),
      record.workspace,
      record.kind === 'approval' ? messages().approvalTitle : messages().questionTitle,
    ),
    subtitle: subtitleFor(record.session),
    tone,
    body: [headline],
    buttons: [],
    forms: [],
  })

  /**
   * Register one escalation: arm the timer, keep the desktop chain running, and
   * settle with whichever side answers first.
   * @param request - the pending approval or question request.
   * @param next - delegate to the answerers behind this listener.
   * @param kind - which seam is being escalated.
   */
  function escalate(request, next, kind) {
    const desktop = next()
    // A channel that cannot deliver right now must not arm a timer: the desktop
    // chain stays authoritative and no request is left waiting on a message
    // that will never arrive.
    if (closed || channel.available?.() === false || !escalatable(kind, request)) {
      // One of three reasons, and from the desk they are indistinguishable: the plugin is unloaded,
      // the return path is not up, or this request is not one a person can answer from a card. Said
      // out loud because "the card never came" is otherwise the whole of what anyone can observe.
      diagnostics?.(`升级：不发给手机（kind=${kind}，closed=${closed}，通道可用=${channel.available?.() !== false}，可升级=${escalatable(kind, request)}）。`)
      return desktop
    }

    const record = {
      id: randomUUID().replaceAll('-', '').slice(0, 20),
      kind,
      request,
      /**
       * The workspace this request belongs to, resolved once and carried on the record.
       *
       * A card is rewritten several times as its request is answered, and re-reading
       * the session each time would make the name vanish from a later rewrite whenever
       * the session had been reclaimed in between. What the card says about itself
       * stays what it said when it was sent.
       */
      workspace: workspaceLabel(request.agent?.session?.header?.cwd),
      /**
       * The session this request came from, so the card can say which one it is.
       *
       * Carried for the same reason the workspace is: a card is rewritten as its request is answered,
       * and a rewrite starts from what the record holds rather than from the session, which may be
       * gone by then. The *name* is looked up at render time instead of being copied here — a title
       * can arrive after the request does (the generator is asynchronous), and a card that already
       * exists should pick it up on its next rewrite rather than keep the blank it started with.
       */
      session: request.agent?.session?.id,
      handle: undefined,
      delivered: false,
      timer: undefined,
      /**
       * Whether this request's card went out without the desk head start.
       *
       * A request that arrives while the phone holds the person skips the head start rather than
       * shortening it: the wait is zero, so the card goes out at once. That is right while nobody
       * is at the desk — but such a request never had a head start to lose, so it is the one that
       * is still eligible for one if somebody comes back before its card lands. See
       * {@link deskReturn}.
       */
      noHeadStart: false,
      /** When this request arrived, so a change to the wait keeps the time already spent. */
      startedAt: Date.now(),
      /**
       * Whether this record's current deadline has been reached and its card committed to.
       *
       * Distinct from `delivered`, which is only set once the platform answers: a send in flight is
       * neither delivered nor still waiting, and treating it as waiting is how a re-time would
       * order a second card for one question.
       */
      triggered: false,
      finished: false,
      answers: new Map(),
      settle: Promise.withResolvers(),
      released: Promise.withResolvers(),
      onAbort: undefined,
    }
    record.view = buildView(record)
    open.set(record.id, record)

    /** Release the timer and the registry slot without settling the race. */
    const release = () => {
      if (record.timer !== undefined) {
        clearTimeout(record.timer)
        record.timer = undefined
      }
      open.delete(record.id)
      // The card is answered or gone, so a typed answer quoting it must not reach a record the phone
      // can no longer decide anything about. Dropped here, in the one function that knows everything a
      // record holds, rather than at each of the three places that release it.
      if (record.handle !== undefined) byHandle.delete(record.handle)
      request.signal?.removeEventListener('abort', record.onAbort)
    }

    /**
     * Close the escalation and, when a message went out, show its outcome.
     * @returns true only for the first caller.
     */
    record.complete = (outcome, headline, tone) => {
      if (record.finished) return false
      record.finished = true
      release()
      if (record.delivered && headline !== undefined && typeof channel.update === 'function') {
        void rewriteRetried(record.handle, settledView(record, headline, tone), messages().logMessageRewriteFailed)
      }
      if (outcome !== undefined) record.settle.resolve(outcome)
      return true
    }

    /**
     * Give up on the phone without settling the request.
     *
     * Used when the card cannot be delivered: the desktop branch of the race is
     * still pending and still authoritative, so the caller keeps waiting on it
     * rather than receiving an answer nobody gave. The escalation leaves the
     * registry, and a press that arrives afterwards finds no live request.
     * @param record - the escalation to release.
     */
    const abandon = (record) => {
      record.finished = true
      release()
      record.released.resolve()
    }

    record.onAbort = () => { record.complete(undefined, messages().cancelled, 'muted') }
    // Attached so {@link close} can abandon a record through the one function that knows everything
    // it holds — the timer, its registry slot, and the listener it put on the request's signal.
    record.release = release
    if (request.signal?.aborted === true) {
      record.complete(undefined, undefined, 'muted')
      return desktop
    }
    request.signal?.addEventListener('abort', record.onAbort, { once: true })

    /**
     * Whether this record's card is still to be sent.
     *
     * Three things say no, and each is a different reason: the request was answered or dropped,
     * its card is on the phone, or its card is on its way there. Only the last is transient — and
     * it is what keeps a re-time from racing a send that has already been committed to.
     */
    const pending = () => !record.finished && !record.delivered && !record.triggered

    /**
     * Arm the wait, or re-arm it against a deadline counted from the request's arrival.
     *
     * The deadline is the arrival plus the wait in force, so a change to the wait keeps the
     * time already spent: a request that has waited 100 of 120 seconds and meets a
     * 20-second value goes out now, rather than after another 20. The wait is read here
     * rather than passed in, because two things can change it — the setting, and which side
     * the person is on — and both have to reach a countdown that is already running.
     */
    const arm = () => {
      if (record.timer !== undefined) clearTimeout(record.timer)
      // Read once, because the delay is asked for twice below and a move between the sides
      // between the two reads would leave the record claiming a head start it did not get.
      const delay = effectiveDelay()
      // Whether this request skipped the desk's head start. A zero wait means its card goes
      // straight out, so nothing about the desk was consulted for it — which is what makes it
      // recoverable later, and what {@link deskReturn} looks for. It only ever becomes true:
      // re-arming is *how* a head start is given back, so a later non-zero wait must not be read
      // as the request having had one all along.
      if (delay === 0) record.noHeadStart = true
      // A new deadline means the card is to be sent again, so the send that was committed to is no
      // longer the one this record is waiting on. This is what reopens the window {@link deskReturn}
      // needs — without it, a request whose first card left at once could never be re-timed.
      record.triggered = false
      const remaining = record.startedAt + delay * 1000 - Date.now()
      record.timer = setTimeout(() => {
        record.timer = undefined
        // Set before the send, not after it resolves: from here the card is either on the phone or
        // on its way, and a re-time must not treat either as "never sent".
        record.triggered = true
        void deliverCard(record).then((handle) => {
          record.handle = handle
          record.delivered = true
          // Remembered against the message, not only on the record: a press that arrives
          // after a restart finds no record, and rewriting that card must still be able
          // to name the session it belonged to.
          workspaces?.record(handle, record.workspace)
          // And the same message is how a *typed* answer finds its way back to this record: it
          // carries no payload, only the card it quotes.
          if (typeof handle === 'string' && handle !== '') byHandle.set(handle, record)
        }).catch((error) => {
          log.warn(messages().logDeliveryGivenUp(DELIVERY_MAX_TRIES), error)
          // The card never arrived, so there is no phone decision to wait for.
          // Abandon rather than settle: the promise this call returns stays racing
          // the desktop branch, which is still pending and still authoritative.
          // Settling it here would end the race with no answer at all and hand the
          // caller `undefined` — the caller would not know the desktop had never
          // been consulted, and could not fall back to it.
          abandon(record)
        })
      }, Math.max(0, remaining))
      record.timer.unref?.()
    }

    arm()

    /**
     * Re-time this escalation against a wait that changed under it.
     *
     * A wait that grew must not outlive the request it is holding, and a wait that shrank
     * must not keep somebody waiting for a number nobody chose any more. Only a record still
     * waiting for its first card is re-timed: one that has already gone out is being
     * answered, not delayed.
     */
    record.rearm = () => {
      if (!pending()) return
      arm()
    }

    // A settled or abandoned escalation must never leave the caller waiting. The
    // desktop branch is what remains authoritative once the phone is out of the
    // picture, so the race covers exactly the two live outcomes.
    return Promise.race([
      Promise.resolve(desktop).then((outcome) => {
        // Only an answer that actually settles this race says anything about where the
        // person is. A desk answer arriving after the phone already settled it is the
        // browser catching up, not a person sitting down — and moving the side for it would
        // put the head start back while the reader is still holding the phone.
        if (record.complete(undefined, messages().answeredAtDesk, 'success')) priority?.set(DESK)
        return outcome
      }),
      record.settle.promise,
      record.released.promise.then(() => desktop),
    ])
  }

  /**
   * One rewrite, retried a bounded number of times.
   *
   * A rewrite that fails leaves the card looking answerable — buttons on a decided request, an
   * input box on a retired one — and a card that lies about what it can do is the worst card there
   * is. The common failures (a rate limit, a dropped connection) pass with a retry; a message that
   * no longer exists does not, and is given up on loudly.
   * @param handle - the message to rewrite.
   * @param view - the view to write.
   * @param what - the copy naming the failure, for the log.
   */
  const rewriteRetried = async (handle, view, what) => {
    if (handle === undefined || typeof channel.update !== 'function') return
    for (let attempt = 1; ; attempt += 1) {
      try {
        await channel.update(handle, view)
        return
      } catch (error) {
        if (attempt >= REWRITE_MAX_TRIES) {
          log.warn(`${what}${messages().logRewriteAttempts(attempt)}`, error)
          return
        }
        await sleep(REWRITE_RETRY_MS)
      }
    }
  }

  /**
   * Deliver one request's card, retrying on transient failure under one idempotency key.
   *
   * The budget is chosen to stay far inside the platform's limit, but that limit is documented
   * outside this repository; a size refusal is answered by halving the text and trying once more.
   * Any other failure — a dropped connection, a rate limit — is transient in the common case, and
   * one card is worth retrying for before the escalation is given up on and the request goes back
   * to the desk. Every attempt carries the same `uuid`: a send the platform accepted but whose
   * answer was lost is then answered by the message it already made, never by a second card.
   * @param record - the escalation whose card is being delivered.
   * @returns the delivered message handle.
   */
  async function deliverCard(record) {
    record.uuid ??= randomUUID()
    let view = record.view
    for (let attempt = 1; ; attempt += 1) {
      // An answer that settled the request while a retry waited must not deliver a card for it.
      if (closed || record.finished || record.delivered) {
        throw new Error('escalation is no longer waiting to deliver')
      }
      try {
        return await channel.deliver(view, { uuid: record.uuid })
      } catch (error) {
        const refusal = classifyRefusal(error)
        // The first attempt gives up whatever the platform actually complained about — tables written
        // as text, the fold dropped, or a smaller body — and then the retries are plain retries of
        // that card. Reading every refusal as a size problem is what lost a nine-table answer whose
        // only fault was its table count (issue #74).
        if (attempt === 1 && refusal.kind === 'tables') {
          const { view: flattened, flattened: count } = flattenViewTables(view)
          view = flattened
          diagnostics?.(`审批/提问卡：${count} 张表超过整卡表格预算，已改写为文本后重投。`)
          continue
        }
        if (attempt === 1 && (refusal.kind === 'size' || refusal.kind === 'content')) {
          log.debug(messages().logCardTooLarge)
          view = buildView(record, Math.floor(CARD_TEXT_BUDGET / 2))
          continue
        }
        if (attempt === 1 && refusal.kind === 'elements') {
          const withoutFold = { ...view }
          delete withoutFold.details
          view = withoutFold
          continue
        }
        if (attempt >= DELIVERY_MAX_TRIES) throw error
        log.debug(messages().logDeliveryRetrying(attempt))
        await sleep(DELIVERY_RETRY_MS)
      }
    }
  }

  /**
   * Take the controls off a card whose request is gone.
   *
   * Used when a press names no live request — after a restart, or for a request this
   * process has already dropped. There is no record left to render from, so the card
   * gets the least a card can say rather than the content it had; what matters is that
   * it stops offering buttons that cannot work.
   * @param handle - the message the press came from, as the channel reported it.
   */
  const retireCard = (handle) => {
    const copy = messages()
    void rewriteRetried(handle, {
      // The record this card belonged to is gone, so the workspace comes from what was
      // remembered against the message; a card that cannot be named is still retired.
      title: titleFor(settings(), workspaces?.lookup(handle), copy.requestGoneTitle),
      // The session is remembered beside the message for the same reason the workspace is: this card
      // outlived the record that could have named it.
      subtitle: subtitleFor(workspaces?.sessionOf?.(handle)),
      tone: 'muted',
      body: [copy.requestGone],
      buttons: [],
      forms: [],
    }, copy.logMessageRewriteFailed)
  }

  /** Re-time every request that is still waiting for its card. */
  const rearmAll = () => {
    for (const record of [...open.values()]) record.rearm?.()
  }

  /**
   * Somebody is at the desk again: give back the head start that phone priority took away.
   *
   * Phone priority sets the wait to zero, so every request that arrives while it holds skips the
   * head start and its card goes out at once. If the person then comes back to the desk, those
   * requests would otherwise stay on the phone for good: {@link rearmAll} cannot move them, because
   * it only re-times a request whose card has not gone out, and these sent theirs the moment they
   * arrived.
   *
   * Which of them are recoverable is {@link shouldReturnHeadStart}'s question — it leaves alone
   * every card the desk let the clock run out on, and every card already on the phone. The wait
   * given back is counted from the request's own arrival, exactly as it would have been had the
   * person been at the desk when it came in.
   */
  const deskReturn = () => {
    for (const record of [...open.values()]) {
      if (!shouldReturnHeadStart(record)) continue
      record.rearm?.()
    }
  }

  /**
   * Record that a person answered from the phone, and put the phone in charge.
   *
   * The head start exists to leave room for whoever is at the desk. An answer that came
   * from a card is the evidence that nobody is: the person is holding the phone, and
   * making them wait out a head start for an empty chair delays the only surface that can
   * answer. Every counted-down wait is re-timed on the spot, so the change reaches the
   * requests already in flight rather than only the next one.
   */
  const phoneTookOver = () => {
    if (priority?.set(PHONE) === true) rearmAll()
  }

  /** Answer one approval from an action payload. */
  const decodeApproval = (record, payload) => {
    if (payload?.v === ALLOW_FULL) {
      const full = permissions.fullAccess()
      // The preset was there when the card was drawn and is gone now (a deployment changed its table
      // mid-flight). Refusing to switch is right; settling the request on a policy nobody chose is not.
      if (full === undefined) return { toast: messages().fullAccessUnavailable, accepted: false }
      if (!permissions.set(record.request.agent?.session, full.name)) {
        // Nothing was decided, so nothing is settled: the card keeps its buttons and the reader can
        // still answer it the ordinary way.
        return { toast: messages().fullAccessFailed, accepted: false }
      }
      const label = messages().fullAccessSettled(full.label)
      // This request is granted as well — it is the one the person was looking at — and the card
      // becomes the record of what was chosen, including that this path now goes quiet.
      if (record.complete(ALLOW, label, 'success')) {
        phoneTookOver()
        mirror.record(record, ALLOW)
      }
      return { toast: messages().fullAccessOn(full.label) }
    }
    if (payload?.v !== ALLOW && payload?.v !== REJECT) return undefined
    const label = payload.v === ALLOW ? messages().allowedOnce : messages().rejected
    // Only the answer that actually settles the request is mirrored: a click
    // arriving after the desktop already decided changes nothing.
    if (record.complete(payload.v, label, payload.v === ALLOW ? 'success' : 'danger')) {
      phoneTookOver()
      mirror.record(record, payload.v)
    }
    return { toast: label }
  }

  /** Answer one question, resolving once every question has an answer. */
  const decodeQuestion = (record, payload, values) => {
    const question = record.request.questions.find(item => item.id === payload?.q)
    if (question === undefined) return undefined

    let answer
    if (payload.submit === true) {
      // A card may not hold two elements of the same name, and one request can carry
      // several questions that this side names alike, so the channel is free to name
      // its controls to suit the card it is building and to say what it called them.
      // The names it reported are the ones to read; a card that reported nothing —
      // older than that report — is read under the names this side asked for.
      const submits = payload.submits ?? {}
      const submitted = values?.[submits[FORM_VALUE_FIELD] ?? FORM_VALUE_FIELD]
      const customName = submits[FORM_CUSTOM_FIELD]
      const typed = customName === undefined ? undefined : values?.[customName]
      const selected = Array.isArray(submitted) ? submitted.map(String) : []
      // A form with no options carries its typed answer in the value field; a
      // multi-select form carries choices there and the typed answer beside
      // them, which is the pair the desktop card submits.
      const custom = typeof submitted === 'string' && submitted !== ''
        ? submitted
        : typeof typed === 'string' && typed.trim() !== '' ? typed.trim() : undefined
      if (selected.length === 0 && custom === undefined) return undefined
      answer = { id: question.id, selected, ...(custom === undefined ? {} : { custom }) }
    } else {
      const label = payload?.v
      if (typeof label !== 'string'
        || !(question.options ?? []).some(option => option.label === label)) {
        return undefined
      }
      answer = { id: question.id, selected: [label] }
    }

    record.answers.set(question.id, answer)
    const answered = record.answers.size
    const total = record.request.questions.length
    if (answered < total) {
      // Recorded here rather than only at the end: a reader part-way through a card has
      // already shown they are at the phone, and the wait for the next request should
      // reflect that without waiting for them to finish this one.
      phoneTookOver()
      // Rewrite the message so the user sees what is already recorded; a toast
      // alone would leave a card that looks untouched.
      if (record.delivered && typeof channel.update === 'function') {
        void Promise.resolve(channel.update(record.handle, buildView(record)))
          .catch(error => { log.warn(messages().logMessageRewriteFailed, error) })
      }
      return { toast: messages().recorded(answered, total) }
    }

    const answers = record.request.questions
      .map(item => record.answers.get(item.id))
      .filter(Boolean)
    const copy = messages()
    const summary = clip(answers
      .map(item => `${item.id}=${item.custom ?? item.selected.join('/')}`)
      .join(copy.answerSeparator))
    const accepted = record.complete({ answers }, copy.answered(summary), 'success')
    if (accepted) {
      phoneTookOver()
      mirror.record(record, { answers })
    }
    return { toast: messages().answersSubmitted }
  }


  return {
    /**
     * Escalate one request to the channel, racing the desktop's own answerer.
     * @param request - the pending approval or question request.
     * @param next - delegate to the answerers behind this listener.
     * @param kind - which seam is being escalated.
     * @returns the settled answer.
     */
    escalate,
    /**
     * Route one phone action to its open escalation.
     * @param action - what the channel reported: the echoed payload, the submitted
     *   values, and the message the press came from.
     * @returns the channel's toast response, or undefined for an unknown action.
     */
    handleAction({ payload, values, messageId } = {}) {
      const id = typeof payload?.rid === 'string' ? payload.rid : undefined
      const record = id === undefined ? undefined : open.get(id)
      if (record === undefined) {
        // The card outlived the request it asks about. The registry is in memory, so a
        // restart — or a request this process already settled and dropped — leaves a
        // card whose buttons are still there and whose only answer is a toast saying so.
        // The press carries the message it came from, so the card is rewritten where it
        // lies: `muted`, with the controls gone, so it stops looking answerable.
        // Said at info rather than debug: a stale press is a reader who believed they
        // were deciding something, and "this press did nothing, the request is gone"
        // is the one line that makes that believable afterwards.
        log.info(messages().logStalePress)
        retireCard(messageId)
        return { toast: messages().requestGone, accepted: false }
      }
      const outcome = record.kind === 'approval'
        ? decodeApproval(record, payload)
        : decodeQuestion(record, payload, values)
      if (outcome === undefined) return { toast: messages().actionUnknown, accepted: false }
      // A decoder that decided nothing says so itself — the full-access switch that the service
      // refused claims the press so it can explain, without pretending an answer was given.
      return { toast: outcome.toast, accepted: outcome.accepted ?? true }
    },
    /**
     * Which live request one card on the phone is waiting on.
     *
     * The other side of {@link handleAction}'s key: a press names the request it answers, a typed
     * message names only the card it quotes. Read before the text is interpreted, because *that* is
     * what decides whether the text is an answer or an instruction for a session.
     * @param handle - the message the card lives in.
     * @returns the kind of request waiting there, or undefined when none is.
     */
    requestAt(handle) {
      return typeof handle === 'string' ? byHandle.get(handle)?.kind : undefined
    },
    /**
     * Answer a live request from a typed message.
     *
     * The text is turned into **the payload the card itself would have sent** and handed to the same
     * decoder a press goes through, so everything a press does — settling the race, mirroring the
     * decision to the browser half, rewriting the card in place, counting the person as being at the
     * phone — happens here for the same reasons and in the same order. There is no second answer path
     * to keep in step, which is the whole point: an approval granted by a word is the same
     * `allowed-once` a button grants, and nothing downstream can tell them apart because there is
     * nothing to tell apart.
     *
     * Two shapes of question answer exist, and the card's own question decides which: text equal to an
     * option's label *is* that option, and anything else is the typed answer the card offers beside its
     * choices. A multi-select question cannot be given several selections in one line of text, and
     * rather than guess at separators the text becomes exactly one selection when it names one option
     * and a custom answer when it does not.
     * @param answer - the message the card lives in, and what was typed.
     * @returns whether the request took the answer, and why not when it did not.
     */
    answerByHandle({ handle, text } = {}) {
      const record = typeof handle === 'string' ? byHandle.get(handle) : undefined
      // No live record: the request has been answered already, or this process never had it — it
      // arrived before a restart, or the card belongs to another path entirely. A reason rather than a
      // bare false, because telling the reader is the only useful thing left to do.
      if (record === undefined) return { ok: false, reason: 'request-gone' }
      const typed = String(text ?? '').trim()
      if (typed === '') return { ok: false, reason: 'empty' }

      if (record.kind === 'approval') {
        const outcome = approvalOutcomeFor(typed)
        // Nothing is settled on a word this card does not answer to. Not "reject by default": a
        // typo must not decide anything either way.
        if (outcome === undefined) return { ok: false, reason: 'not-an-answer' }
        return { ok: true, toast: decodeApproval(record, { rid: record.id, v: outcome })?.toast }
      }

      // The question this card is asking: the first one left unanswered, which is the same one
      // `buildView` puts in front of the reader.
      const current = record.request.questions.find(question => !record.answers.has(question.id))
      if (current === undefined) return { ok: false, reason: 'request-gone' }
      // Matched trimmed and case-insensitively: a label is a name rather than a token, and a reader who
      // types it with a stray space or in another case meant that option.
      const named = (current.options ?? []).find(
        option => option.label.trim().toLowerCase() === typed.toLowerCase(),
      )
      const decoded = named === undefined
        ? decodeQuestion(record, { rid: record.id, q: current.id, submit: true }, { [FORM_VALUE_FIELD]: typed })
        : decodeQuestion(record, { rid: record.id, q: current.id, v: named.label })
      if (decoded === undefined) return { ok: false, reason: 'not-an-answer' }
      return { ok: true, toast: decoded.toast }
    },
    /**
     * What the state route reports as open.
     * @returns one entry per live escalation.
     */
    pending() {
      return [...open.values()].map((record) => {
        const question = record.request.questions?.[0]
        return {
          kind: record.kind,
          summary: clip(record.kind === 'approval'
            ? record.request.toolName
            : question?.header ?? question?.question ?? ''),
          delivered: record.delivered,
        }
      })
    },
    /**
     * Abandon every in-flight escalation.
     *
     * Called on disposal: the desktop branch of each race stays authoritative, so
     * a still-open GUI can answer normally.
     *
     * Each record goes through {@link release} rather than repeating what it does. The hand-written
     * version cleared the timer and dropped the registry slot but left the record's `abort` listener
     * on the request's signal — so a retired plugin went on reacting to aborts, and a long-lived
     * signal accumulated listeners (`MaxListenersExceededWarning` after enough of them). Release is
     * the one place that knows everything a record holds, which is why it exists.
     */
    close() {
      closed = true
      for (const record of [...open.values()]) {
        // Set first, because release() is only about what the record holds: the race must not settle
        // an answer nobody gave, and the desktop branch is what the caller keeps waiting on.
        record.finished = true
        record.release?.()
      }
    },
    /**
     * Re-time every request still waiting for its card against the wait in force.
     *
     * Called when the wait changes under a countdown — an edit to the setting, or a move
     * between the sides — because the timer was armed when the request arrived: without
     * this, a change reaches the next request and not the one the reader is looking at.
     */
    rearm() {
      rearmAll()
    },
    /**
     * Give the head start back to the requests that never had one.
     *
     * Called when somebody is provably at the desk again — they answered something there. See
     * {@link deskReturn} for what that does and, more to the point, what it deliberately leaves
     * alone.
     */
    deskReturn,
  }
}
