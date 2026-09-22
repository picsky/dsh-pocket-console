/**
 * The result notifier composed without the activity card: the fallback the reply path
 * lands on when there is no run card to take the message over, and the branches around it.
 *
 * These are the deployment shapes the harness suite never composes: `notices.test.mjs` drives
 * the full plugin, where `activity` is always present and the adopt path swallows the fallback,
 * so the "已收到指令" rewrite and the delivery retries had no positive coverage — a regression
 * there would go green. Each case builds the notifier by hand with only what it names.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createResultNotifier } from '../results.js'

/** Copy the notifier reads while it is deciding and rewriting. */
const COPY = {
  truncated: '…', truncatedOlder: '…', resultTitle: 'Result', replyHint: 'Reply',
  sendToAgent: 'Send', superseded: 'Superseded', readerSpoke: 'Spoke', noticeGone: 'Gone',
  emptyInstruction: 'Empty instruction', noAgent: 'No agent', sent: 'Sent', received: 'Received',
  notSent: 'Not sent', resultProcess: 'Process', resultOmitted: bytes => `omitted ${bytes}`,
  logRunFold: () => 'run fold', logResultView: () => 'result view', logNoticeSent: 'sent',
  logNoticeTooLarge: 'too large', logNoticeRetrying: () => 'retrying', logInstructionQueued: 'queued', logInstructionSteered: 'steered',
  logReplyCardRewritten: () => 'rewritten', logReplyCardAdopted: () => 'adopted',
  logReplyCardNotRewritten: () => 'not rewritten', logNoticeRetired: () => 'retired',
  logNoticeFailed: 'failed', logNoticeCardFailed: 'card failed',
  logRewriteAttempts: () => '',
  logNoticeStoreUnavailable: 'store unavailable', logNoticeStoreReadFailed: 'read failed',
  logNoticeRestoreFailed: 'restore failed', logNoticeStored: () => 'stored',
  noticeStale: 'Stale',
}

/**
 * A notifier wired to a stub host and channel, with a quiet window short enough to fire.
 * @param options - a custom channel (for a delivery that fails), and the agent to serve.
 * @returns the notifier, the session-event sink, the agent, and the channel's record.
 */
function setup({ channel, agent = { status: 'idle', followed: [], followup: (message) => { agent.followed.push(message) } } } = {}) {
  const listeners = new Map()
  const updates = []
  const deliveries = []
  const notifier = createResultNotifier({
    ctx: {
      get: (name) => (name === 'agents' ? { get: () => agent } : undefined),
      on: (event, handler) => {
        listeners.set(event, handler)
        return () => { listeners.delete(event) }
      },
    },
    log: { warn() {}, info() {}, debug() {} },
    channel: channel ?? {
      async deliver(view) {
        deliveries.push(view)
        return 'msg_1'
      },
      async update(handle, view) { updates.push({ handle, view }) },
    },
    settings: () => ({
      delaySeconds: 0.02, titlePrefix: 'DSH',
      resultNotify: 'idle', resultNotifyCooldownSeconds: 0,
    }),
    messages: () => COPY,
  })
  notifier.install()
  const sink = listeners.get('session/event')
  assert.equal(typeof sink, 'function', 'the notifier watches the session firehose')
  return { notifier, sink, agent, updates, deliveries }
}

/** Drive one complete, finished turn into the notifier. */
function runTurn(sink, session, { said = 'go', answer = 'done', reason = { kind: 'completed' } } = {}) {
  sink(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: said }] } })
  sink(session, { type: 'turn/start', data: { turn: 1 } })
  sink(session, {
    type: 'assistant/message', surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: answer }] } },
  })
  sink(session, { type: 'turn/end', data: { turn: 1, reason } })
}

/** Wait past the 20 ms quiet window, so the notice the turn earned has been offered. */
const waitForFire = () => new Promise(resolve => setTimeout(resolve, 60))

test('without the activity card, a reply is rewritten on the card it was typed on', async () => {
  const { notifier, sink, agent, deliveries, updates } = setup()
  const session = { id: 's1' }
  runTurn(sink, session)
  await waitForFire()

  assert.equal(deliveries.length, 1, 'a result card is offered')
  const view = deliveries[0]
  const nid = view.forms[0].payload.nid
  const field = view.forms[0].fieldId
  assert.equal(typeof nid, 'string', 'the card carries its own single-use rid')

  const outcome = await notifier.handleAction({
    payload: { nid, submit: true },
    values: { [field]: 'next' },
    messageId: 'msg_1',
  })
  assert.equal(outcome.accepted, true, 'the press is accepted')
  assert.equal(agent.followed.length, 1, 'and the instruction reached the session')

  // No activity card to take the message over, so the fallback rewrites the card
  // in place: the answer stays, the box goes, and the card says the instruction
  // arrived — the shape every release before the adopt path used.
  assert.equal(updates.length, 1, 'the card is rewritten')
  assert.ok(
    updates[0].view.body.some(part => part === COPY.received),
    'and says the instruction arrived',
  )
  assert.deepEqual(updates[0].view.forms, [], 'with the reply box gone')
  assert.ok(
    updates[0].view.body.some(part => part === 'done'),
    'and the answer it carried is kept',
  )
})

test('an empty instruction is refused and the card stays answerable', async () => {
  const { notifier, sink, deliveries, updates } = setup()
  const session = { id: 's1' }
  runTurn(sink, session)
  await waitForFire()

  const view = deliveries[0]
  const nid = view.forms[0].payload.nid
  const field = view.forms[0].fieldId

  const outcome = await notifier.handleAction({
    payload: { nid, submit: true },
    values: { [field]: '   ' },
    messageId: 'msg_1',
  })
  assert.equal(outcome.accepted, false, 'an empty press is refused')
  assert.equal(outcome.toast, COPY.emptyInstruction, 'and says what was wrong')
  assert.equal(updates.length, 0, 'and the card is not rewritten')
  // The notice is still live: a real instruction typed next still lands.
  const again = await notifier.handleAction({
    payload: { nid, submit: true },
    values: { [field]: 'next' },
    messageId: 'msg_1',
  })
  assert.equal(again.accepted, true, 'the card answers the next press')
})

test('a result refused for size is retried with the fold given up, smaller', async () => {
  let attempts = 0
  const deliveries = []
  const updates = []
  const { notifier, sink } = setup({
    channel: {
      async deliver(view) {
        attempts += 1
        // A size refusal the core recognises: it halves the text and gives up the fold.
        if (attempts === 1) throw new Error('card content is too large')
        deliveries.push(view)
        return 'msg_1'
      },
      async update(handle, view) { updates.push({ handle, view }) },
    },
  })
  const session = { id: 's1' }
  runTurn(sink, session)
  await waitForFire()

  assert.equal(attempts, 2, 'a size refusal is retried once')
  assert.equal(deliveries.length, 1, 'and the retry is what lands')
  assert.equal(deliveries[0].details, undefined, 'the fold is what is given up')
  assert.ok(deliveries[0].body[0].length < 100, 'the retry carries the answer, clipped')
  assert.equal(typeof deliveries[0].forms[0].payload.nid, 'string', 'and the reply box is still there')
})
