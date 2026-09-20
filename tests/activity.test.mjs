/**
 * The activity card: what a run is doing, while it is doing it.
 *
 * How these cases read the card, and why:
 *
 * - Through `cardTitled` / `cardFrom`, which locate a card by the handle the platform returned.
 *   Reading "the newest patch anywhere" would let a body assertion pass against a different
 *   card — the escalation a case uses to take the phone over is a card too.
 * - After `settle()`, longer than the refresh window: the card is edited on a trailing window,
 *   so reading immediately would read the version from before the event.
 * - Never through `sentCard()`, which asserts that exactly one card was delivered. These cases
 *   cause more than one on purpose.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sleep,
  clickCard,
  scaffold,
  bind,
  callbackValues,
  sentCard,
  observed,
  lastDelivered,
  cardFrom,
  cardTitled,
} from './support/harness.mjs'

/** Wait past one refresh window, so the card reflects everything emitted before it. */
const settle = () => sleep(400)

/** The title every activity card starts with, which no other card does. */
const ACTIVITY_TITLE = 'DSH 执行中'

/**
 * The activity card this deployment has sent, with the handle it lives in.
 * @returns the handle and current card, or undefined when none has been sent.
 */
const activityCard = () => cardTitled(ACTIVITY_TITLE)

/**
 * Emit one text delta on the live stream, the way the model produces them.
 *
 * Through `emitFrame`, which delivers the single `{ agent, frame }` payload Cordis delivers.
 * The event name is not spelled out here on purpose: a case that assembled its own two-argument
 * emission would certify a call shape the deployment never produces — which is how the live
 * stream once shipped reading a second argument that never arrived.
 * @param scaffolded - the scaffold result.
 * @param session - session id.
 * @param text - the delta.
 */
function delta(scaffolded, session, text) {
  scaffolded.emitFrame(session, { type: 'chunk', chunk: { type: 'text-delta', text } })
}

/**
 * Put the phone in charge by answering a card, which is what takes the head start away.
 * @param scaffolded - the scaffold result.
 */
async function takeOverFromThePhone(scaffolded) {
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(1100)
  await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
}

/**
 * A deployment where the phone holds the person.
 * @returns the scaffold result.
 */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  return scaffolded
}

/**
 * Start a run and return the activity card it caused.
 * @param scaffolded - a scaffold where the phone holds the person.
 * @param session - session id.
 * @returns the handle and card of the activity card.
 */
async function startRun(scaffolded, session) {
  scaffolded.emitToAll('session/event', { id: session }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  const shown = activityCard()
  assert.ok(shown, 'the run is shown')
  return shown
}

test('no activity card is sent while the desk holds the person', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)

  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  delta(scaffolded, 's_1', '正在检查。')
  await settle()

  // The desk is where this run is visible, so a card on the phone would be a message nobody
  // asked for — which is the one thing this plugin says it does not send.
  assert.equal(activityCard(), undefined, 'the desk having the person means no activity card')
})

test('a run under phone priority gets one card, and its text grows', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle, card } = await startRun(scaffolded, 's_1')
  assert.equal(card.header.template, 'blue', 'a run in progress is the calm colour')

  delta(scaffolded, 's_1', '先看一下')
  await settle()
  assert.match(JSON.stringify(cardFrom(handle)), /先看一下/, 'and carries the text')

  const before = lastDelivered()
  delta(scaffolded, 's_1', '测试失败的那两个用例')
  await settle()
  // The card is a message that is rewritten, never a new message: sending again would notify,
  // and a card that announces itself on every paragraph is the noise this design avoids.
  assert.equal(lastDelivered(), before, 'and it is never re-sent')
  assert.match(JSON.stringify(cardFrom(handle)), /先看一下测试失败的那两个用例/, 'the text grew in place')
})

test('a burst of deltas becomes one edit, not one edit per delta', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')
  observed.patched.length = 0

  // Sixty deltas in one burst, which is what a model writing a paragraph produces. Feishu
  // allows five edits a second to one message, so this has to collapse rather than be refused.
  for (let index = 0; index < 60; index += 1) delta(scaffolded, 's_1', `第${index}段 `)
  await settle()

  const edits = observed.patched.filter(entry => entry.path?.message_id === handle).length
  assert.equal(edits, 1, `sixty deltas in one window are one edit: ${edits}`)
  assert.match(JSON.stringify(cardFrom(handle)), /第59段/, 'and the card carries the newest of them')
})

test('the card keeps the newest fragments and nothing else', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  for (const piece of ['一', '二', '三', '四', '五']) {
    delta(scaffolded, 's_1', piece)
    await settle()
  }

  const content = JSON.stringify(cardFrom(handle))
  // The card shows the tail of the stream — what the model is writing now — not the whole
  // answer, which is what the result notice is for.
  assert.match(content, /三四五/, 'the newest three are what the card carries')
  assert.equal(content.includes('一'), false, 'and the older ones have been dropped')
})

test('a card carries nothing to press', async () => {
  const scaffolded = await phoneHoldsIt()
  const { card } = await startRun(scaffolded, 's_1')

  // A card being interacted with cannot be updated, and being updated is this card's whole job.
  assert.deepEqual(callbackValues(card), [], 'no button and no form is on it')
  assert.equal(JSON.stringify(card).includes('collapsible_panel'), false, 'and nothing to unfold')
})

test('the card names the session it belongs to', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)
  scaffolded.agents.set('s_ws', {
    status: 'running',
    session: { header: { cwd: '/work/my-app' } },
  })
  await takeOverFromThePhone(scaffolded)

  const { card } = await startRun(scaffolded, 's_ws')
  assert.equal(card.header.title.content, 'DSH 执行中 · my-app', 'the title names the workspace')
})

test('the card says what the run is doing, and stops saying it when the turn ends', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')
  assert.match(JSON.stringify(cardFrom(handle)), /处理中/, 'a running step says so')
  assert.equal(JSON.stringify(cardFrom(handle)).includes('undefined'), false, 'and nothing reads as undefined')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, callId: 'c1', name: 'npm test' },
  })
  await settle()
  assert.match(JSON.stringify(cardFrom(handle)), /npm test/, 'a tool call is named')
  assert.match(JSON.stringify(cardFrom(handle)), /等待工具/, 'and the status says what it waits on')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()
  assert.match(JSON.stringify(cardFrom(handle)), /已停止/, 'a finished turn stops claiming to run')
  assert.equal(JSON.stringify(cardFrom(handle)).includes('npm test'), false, 'and stops naming the tool')
})

test('a turn that ends while its first send is in flight still gets rendered', async () => {
  const scaffolded = await phoneHoldsIt()

  // The end lands while the create is still being awaited — a network round trip, which is the
  // ordinary case. Whatever changed in the meantime has to reach the card: dropping it leaves a
  // card that says "Working" for good, and hides a failure entirely.
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'error', error: { message: '模型连接中断' } } },
  })
  await settle()
  await settle()

  const content = JSON.stringify(activityCard()?.card)
  assert.match(content, /出错/, 'the failure reaches a card that was still being sent')
  assert.match(content, /模型连接中断/, 'with its reason')
  assert.equal(content.includes('处理中'), false, 'and it does not keep claiming to work')
})

test('a send that fails is retried, and not on the very next window', async () => {
  const scaffolded = await phoneHoldsIt()

  const before = lastDelivered()
  observed.failNextDelivery = 'the platform refused'
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  assert.equal(lastDelivered(), before, 'the first attempt failed, so no card exists yet')

  // Held back rather than retried immediately: a channel that is down must not be hammered at
  // the refresh rate, and a response lost after the platform accepted the card must not become
  // a second card a quarter of a second later.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, name: 'npm test' },
  })
  await settle()
  assert.equal(lastDelivered(), before, 'the retry waits its turn')
})

test('the desk taking the person back before the write means no card after all', async () => {
  const scaffolded = await phoneHoldsIt()

  const before = lastDelivered()
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  // The desk answers inside the refresh window, which is long enough for that to happen. The card
  // was decided under phone priority and would be written under desk priority, and a message the
  // desk is not expecting is exactly the notification this plugin does not send.
  const approval = scaffolded.listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const answered = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  await answered
  await settle()

  assert.equal(lastDelivered(), before, 'the person went back to the desk before anything was written')
})

test('taking the phone over mid-turn picks the running turn up', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)

  // The turn starts while the desk has the person, so nothing is shown for it.
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  await settle()
  assert.equal(activityCard(), undefined, 'the desk had the person')

  await takeOverFromThePhone(scaffolded)
  // The turn is still running, and the phone is where the person now is. Waiting for the next
  // turn would be waiting for the wrong thing: this is the turn they took the phone over for.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, name: 'npm test' },
  })
  await settle()

  const shown = activityCard()
  assert.ok(shown, 'the running turn is shown now')
  assert.match(JSON.stringify(shown.card), /npm test/, 'and shows where it is')
  assert.match(JSON.stringify(shown.card), /第 1 轮/, 'for the turn that was already running')
})
