/**
 * The channel contract as the escalation machine relies on it.
 *
 * These cases drive `createEscalation` with a channel built for the case, where
 * the others run the real Feishu channel through the plugin. They cover the
 * three ways a request must *not* be left waiting on a message: a channel that
 * cannot deliver right now, a request this channel cannot fully answer, and a
 * delivery the platform refuses — each of which has to leave the desktop chain
 * authoritative rather than strand the request on a card nobody will see.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEscalation } from '../escalation.js'

/** Copy for a case that is not about language. */
const COPY = {
  approvalTitle: 'Tool approval', questionTitle: 'Question',
  questionOf: (position, total) => `Question ${position} of ${total}`,
  toolLabel: tool => `**Tool**: ${tool}`, callIdLabel: id => `**Call id**: ${id}`,
  reasonLabel: reason => `**Reason**: ${reason}`,
  approvalLive: 'live', approvalUpgraded: seconds => `upgraded after ${seconds}s`,
  allowOnce: 'Allow once', reject: 'Reject', optionsLegend: '**Options**',
  progress: (answered, total) => `${answered}/${total}`, selectionSeparator: ', ',
  answerSeparator: '; ', submitAnswer: 'Submit', submitOther: 'Other',
  allowedOnce: 'Allowed', rejected: 'Rejected', cancelled: 'Cancelled',
  answeredAtDesk: 'Answered at the desk', recorded: (a, t) => `${a}/${t}`,
  answered: summary => `Answered: ${summary}`, answersSubmitted: 'Submitted',
  requestGone: 'Gone', requestGoneTitle: 'Ended', actionUnknown: 'Unknown', truncated: '…',
  // The log lines the machine reaches for, so a case that settles or retries does
  // not fail on copy rather than on behaviour.
  logMessageRewriteFailed: 'rewrite failed', logDeliveryFailed: 'delivery failed',
  logCardTooLarge: 'card too large', logMirror: status => status,
  logDeliveryRetrying: () => 'retrying', logDeliveryGivenUp: () => 'gave up',
  logStalePress: 'stale press', logRewriteAttempts: () => '',
}

/**
 * A channel that records what the escalation asked of it.
 * @param options - what this transport can do, and how it fails.
 * @returns the channel and the record of its deliveries.
 */
function stubChannel({ available = true, supportsForms = true, deliver } = {}) {
  const delivered = []
  return {
    delivered,
    channel: {
      supportsForms,
      ...(available === undefined ? {} : { available: () => available }),
      async deliver(view) {
        delivered.push(view)
        if (deliver !== undefined) return await deliver(view)
        return { id: `handle_${delivered.length}` }
      },
      async update() {},
      subscribe() { return () => {} },
      close() {},
    },
  }
}

/** An escalation over one stub channel. */
function machine(channel, settings = {}) {
  return createEscalation({
    log: { warn() {}, info() {}, debug() {} },
    channel,
    settings: () => ({ delaySeconds: 0, titlePrefix: 'DSH', ...settings }),
    mirror: { record() {}, report() {}, state: () => ({ sync: null, mirror: [] }) },
    messages: () => COPY,
  })
}

test('a channel that cannot deliver arms no timer and leaves the desktop in charge', async () => {
  const { channel, delivered } = stubChannel({ available: false })
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
    'approval',
  )
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(delivered.length, 0, 'nothing is sent to a channel that is not reachable')
  assert.deepEqual(escalation.pending(), [], 'and no escalation is left open')
  // The desktop branch is untouched: it still decides this request.
  desktop.resolve('allowed-once')
  assert.equal(await result, 'allowed-once')
})

test('a request the channel cannot fully answer is left to the desktop', async () => {
  const { channel, delivered } = stubChannel({ supportsForms: false })
  const escalation = machine(channel)

  // A multi-select question needs a form; answering only its first option would
  // settle the request with an answer the user never gave.
  const desktop = Promise.withResolvers()
  const result = escalation.escalate({
    questions: [{ id: 'pick', question: 'Which?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }],
    signal: new AbortController().signal,
  }, () => desktop.promise, 'question')

  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(delivered.length, 0, 'a partially answerable request is never carded')
  assert.deepEqual(escalation.pending(), [])

  desktop.resolve({ answers: [{ id: 'pick', selected: ['a', 'b'] }] })
  assert.deepEqual(await result, { answers: [{ id: 'pick', selected: ['a', 'b'] }] })
})

test('a transient refusal is retried, and the request is not abandoned early', async () => {
  // Not a size refusal: the core retries those once, smaller. This is the case
  // the comment at the delivery site is about — a failure that may pass with a
  // retry must not hand the request back while a card could still arrive.
  let attempts = 0
  const { channel, delivered } = stubChannel({
    deliver: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('the platform is unavailable')
      return { id: 'handle_retry' }
    },
  })
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
    'approval',
  )
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(delivered.length, 1, 'the first attempt was made')
  assert.equal(escalation.pending().length, 1, 'and the escalation is still retrying, not abandoned')

  // The retried delivery goes out under the same key and the card arrives.
  await new Promise(resolve => setTimeout(resolve, 5_200))
  assert.equal(delivered.length, 2, 'the retry reached the channel')
  assert.equal(escalation.pending()[0].delivered, true, 'and the card is on the phone')

  desktop.resolve('allowed-once')
  assert.equal(await result, 'allowed-once', 'the desktop answer still decides')
})

test('a channel that keeps refusing is given up on, and the desktop stays authoritative', async () => {
  // One card is worth a bounded number of attempts; after that the escalation is
  // given up on rather than retried forever, and the request goes back to the desk.
  const { channel, delivered } = stubChannel({
    deliver: async () => { throw new Error('the platform is unavailable') },
  })
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
    'approval',
  )
  await new Promise(resolve => setTimeout(resolve, 16_000))

  assert.equal(delivered.length, 4, 'one card is worth four attempts')
  assert.deepEqual(escalation.pending(), [], 'then the escalation is given up on')

  // The call must still settle with the desktop's answer. Before this was fixed
  // the escalation settled with no answer at all, so the race resolved to
  // `undefined` while the desktop branch was never consulted — the request then
  // sat unresolved behind it and the caller waited forever.
  desktop.resolve('allowed-once')
  assert.equal(await result, 'allowed-once', 'the desktop answer still decides')
})

test('a delivery the platform refuses for size is retried once, smaller', async () => {
  let attempts = 0
  const { channel, delivered } = stubChannel({
    deliver: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('card content is too large')
      return { id: 'handle_retry' }
    },
  })
  const escalation = machine(channel, { delaySeconds: 0 })

  const desktop = Promise.withResolvers()
  const result = escalation.escalate({
    toolName: 'pwsh',
    agent: { status: 'idle', session: { header: { cwd: '/work/my-app' } } },
    // Past the card's own byte budget, so the first attempt is clipped and the
    // retry, at half the budget, genuinely carries less. Sized against the budget
    // the deployment actually uses: a fixture that fits is retried identically,
    // and the assertion below cannot tell the retry from the first attempt.
    reason: 'x'.repeat(60_000),
    signal: new AbortController().signal,
  }, () => desktop.promise, 'approval')

  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(attempts, 2, 'the size refusal is retried once')
  const retryBody = delivered[1].body.join('\n')
  const firstBody = delivered[0].body.join('\n')
  assert.ok(retryBody.length < firstBody.length, `the retry carries less text (${retryBody.length} < ${firstBody.length})`)
  // The retry rebuilds the whole view, so it is the one place a title could quietly be
  // assembled from something other than the record — and it would be the card the reader
  // actually receives.
  assert.equal(delivered[1].title, 'DSH Tool approval · my-app', 'the retried card keeps the workspace')

  desktop.resolve('rejected')
  assert.equal(await result, 'rejected')
})

test('a phone answer settles the race even if the desktop branch fails afterwards', async () => {
  // The phone wins; the desktop branch is still pending, and the answerer behind it
  // can then fail — a dropped client, a closed session. That failure must neither
  // change the answer nor escape as an unhandled rejection, which a process treats
  // as fatal. The losing branch is detached from the moment the race settles.
  const { channel, delivered } = stubChannel()
  const escalation = machine(channel)

  const escapes = []
  const onEscape = (reason) => { escapes.push(reason) }
  process.on('unhandledRejection', onEscape)
  try {
    const desktop = Promise.withResolvers()
    const result = escalation.escalate(
      { toolName: 'pwsh', signal: new AbortController().signal },
      () => desktop.promise,
      'approval',
    )
    await new Promise(resolve => setTimeout(resolve, 30))

    const allow = delivered[0].buttons.find(button => button.payload.v === 'allowed-once')
    const handled = escalation.handleAction({ payload: allow.payload })
    assert.equal(handled.accepted, true, 'the phone answer is the one that settles it')
    assert.equal(await result, 'allowed-once', 'and it is what the caller receives')

    desktop.reject(new Error('the desktop answerer failed after the fact'))
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.deepEqual(escapes, [], 'the detached branch cannot take the process down')
  } finally {
    process.off('unhandledRejection', onEscape)
  }
})

test('an aborted request settles when the desktop answers, and never delivers', async () => {
  // An abort is a withdrawal, not an answer: the escalation gives up the phone side
  // and the desktop branch decides. What it must not do is answer on the desktop's
  // behalf — the caller receives whatever the desktop actually produced.
  const { channel, delivered } = stubChannel()
  const escalation = machine(channel, { delaySeconds: 30 })
  const controller = new AbortController()
  const desktop = Promise.withResolvers()

  const result = escalation.escalate(
    { toolName: 'pwsh', signal: controller.signal },
    () => desktop.promise,
    'approval',
  )
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(delivered.length, 0, 'a withdrawn request never reaches the phone')
  assert.deepEqual(escalation.pending(), [], 'and it leaves the registry')

  desktop.resolve('cancelled')
  assert.equal(await result, 'cancelled', 'the desktop outcome is what the caller sees')
})

test('disposal abandons the phone side and leaves the desktop branch to answer', async () => {
  const { channel, delivered } = stubChannel()
  const escalation = machine(channel, { delaySeconds: 30 })
  const desktop = Promise.withResolvers()

  const result = escalation.escalate(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
    'approval',
  )

  escalation.close()
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(delivered.length, 0, 'a disposed escalation must not deliver a card')
  assert.deepEqual(escalation.pending(), [], 'and the registry is emptied')
  assert.equal(
    escalation.handleAction({ payload: { rid: 'whatever', v: 'allowed-once' } }).accepted,
    false,
    'a press after disposal is refused rather than answered',
  )

  // The request itself was never decided, so the caller follows the desktop.
  desktop.resolve('allowed-once')
  assert.equal(await result, 'allowed-once')
})
