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
 * views, and the two decoders that turn a phone action into an answer.
 *
 * @module pocket-console/escalation
 */

import { CARD_TEXT_BUDGET, clipToBytes, looksLikeSizeRefusal } from './budget.js'

import { randomUUID } from 'node:crypto'

/** Approval outcome meaning "this one call may proceed". */
const ALLOW = 'allowed-once'
/** Approval outcome meaning "do not proceed". */
const REJECT = 'rejected'
/** Form field carrying the chosen options, or the typed answer when none are offered. */
const FORM_VALUE_FIELD = 'value'
/** Form field carrying a typed answer beside a multi-select's options. */
const FORM_CUSTOM_FIELD = 'custom'

/**
 * Create the escalation state machine.
 * @param options - the logger, the channel, the settings, mirror, and copy
 *   thunks, and whether the channel is closed for new work.
 * @returns the answerer, the action router, the pending report, and disposal.
 */
export function createEscalation({ log, channel, settings, mirror, messages, isClosed = () => false }) {
  /** Live escalations keyed by the opaque id embedded in their action payloads. */
  const open = new Map()
  /** Set by close(): an escalation started after disposal must not arm a timer. */
  let closed = false

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
      body.push(settings().delaySeconds === 0
        ? copy.approvalLive
        : copy.approvalUpgraded(settings().delaySeconds))
      return {
        title: `${settings().titlePrefix} ${copy.approvalTitle}`,
        tone: 'warning',
        body,
        buttons: [
          { payload: { rid: record.id, v: ALLOW }, label: copy.allowOnce, tone: 'primary' },
          { payload: { rid: record.id, v: REJECT }, label: copy.reject, tone: 'danger' },
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
        ? `${settings().titlePrefix} ${copy.questionOf(position, questions.length)}`
        : `${settings().titlePrefix} ${copy.questionTitle}`,
      tone: 'info',
      body,
      buttons,
      forms,
    }
  }

  /** The terminal view shown once a request has been decided. */
  const settledView = (record, headline, tone) => ({
    title: `${settings().titlePrefix} ${record.kind === 'approval' ? messages().approvalTitle : messages().questionTitle}`,
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
    if (closed || channel.available?.() === false || !escalatable(kind, request)) return desktop

    const record = {
      id: randomUUID().replaceAll('-', '').slice(0, 20),
      kind,
      request,
      handle: undefined,
      delivered: false,
      timer: undefined,
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
        void Promise.resolve(channel.update(record.handle, settledView(record, headline, tone)))
          .catch(error => { log.warn(messages().logMessageRewriteFailed, error) })
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
    if (request.signal?.aborted === true) {
      record.complete(undefined, undefined, 'muted')
      return desktop
    }
    request.signal?.addEventListener('abort', record.onAbort, { once: true })

    record.timer = setTimeout(() => {
      record.timer = undefined
      void deliverCard(record).then((handle) => {
        record.handle = handle
        record.delivered = true
      }).catch((error) => {
        log.warn(messages().logDeliveryFailed, error)
        // The card never arrived, so there is no phone decision to wait for.
        // Abandon rather than settle: the promise this call returns stays racing
        // the desktop branch, which is still pending and still authoritative.
        // Settling it here would end the race with no answer at all and hand the
        // caller `undefined` — the caller would not know the desktop had never
        // been consulted, and could not fall back to it.
        abandon(record)
      })
    }, settings().delaySeconds * 1000)
    record.timer.unref?.()

    // A settled or abandoned escalation must never leave the caller waiting. The
    // desktop branch is what remains authoritative once the phone is out of the
    // picture, so the race covers exactly the two live outcomes.
    return Promise.race([
      Promise.resolve(desktop).then((outcome) => {
        record.complete(undefined, messages().answeredAtDesk, 'success')
        return outcome
      }),
      record.settle.promise,
      record.released.promise.then(() => desktop),
    ])
  }

  /**
   * Deliver one request's card, retrying once with half the text when the platform
   * refuses it for size.
   *
   * The budget is chosen to stay far inside the platform's limit, but that limit
   * is documented outside this repository; the retry is what keeps a card arriving
   * even if the real ceiling is lower than the documentation says.
   * @param record - the escalation whose card is being delivered.
   * @returns the delivered message handle.
   */
  async function deliverCard(record) {
    try {
      return await channel.deliver(record.view)
    } catch (error) {
      if (!looksLikeSizeRefusal(error)) throw error
      log.debug(messages().logCardTooLarge)
      return await channel.deliver(buildView(record, Math.floor(CARD_TEXT_BUDGET / 2)))
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
    if (handle === undefined || typeof channel.update !== 'function') return
    const copy = messages()
    void Promise.resolve(channel.update(handle, {
      title: `${settings().titlePrefix} ${copy.requestGoneTitle}`,
      tone: 'muted',
      body: [copy.requestGone],
      buttons: [],
      forms: [],
    })).catch(error => { log.warn(copy.logMessageRewriteFailed, error) })
  }

  /** Answer one approval from an action payload. */
  const decodeApproval = (record, payload) => {
    if (payload?.v !== ALLOW && payload?.v !== REJECT) return undefined
    const label = payload.v === ALLOW ? messages().allowedOnce : messages().rejected
    // Only the answer that actually settles the request is mirrored: a click
    // arriving after the desktop already decided changes nothing.
    if (record.complete(payload.v, label, payload.v === ALLOW ? 'success' : 'danger')) {
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
    if (accepted) mirror.record(record, { answers })
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
        retireCard(messageId)
        return { toast: messages().requestGone, accepted: false }
      }
      const outcome = record.kind === 'approval'
        ? decodeApproval(record, payload)
        : decodeQuestion(record, payload, values)
      if (outcome === undefined) return { toast: messages().actionUnknown, accepted: false }
      return { toast: outcome.toast, accepted: true }
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
     */
    close() {
      closed = true
      for (const record of [...open.values()]) {
        if (record.timer !== undefined) clearTimeout(record.timer)
        record.finished = true
        open.delete(record.id)
      }
    },
  }
}
