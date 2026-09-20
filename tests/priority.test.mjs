/**
 * Which side the person is on, and what the timers count down because of it.
 *
 * The state itself is small; what matters is that every signal which can move it does, that
 * a moved side reaches a wait already counting down, and that it survives a restart.
 *
 * The two concerns are kept apart on purpose. "The configured wait still applies" is a case
 * of its own with a long wait and nothing delivered; every other case runs with a short wait
 * so that the card it is about actually arrives, and asserts the side rather than the timing.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { shouldReturnHeadStart } from '../priority.js'
import {
  sleep,
  clickCard,
  scaffold,
  bind,
  callbackValues,
  controlNames,
  sentCard,
  observed,
  lastDelivered,
  cardFrom,
} from './support/harness.mjs'

/**
 * Wait until the channel has delivered a given number of cards.
 *
 * `sentCard` asserts a total of one card, which the cases below deliberately exceed: they need
 * the card from before a request and the card from after it, and reading "the newest delivery,
 * whatever it is" would let an assertion pass against the wrong one.
 * @param count - how many deliveries to wait for.
 * @returns the handle of the newest one.
 */
async function cardsArrived(count) {
  for (let attempt = 0; attempt < 60 && observed.created.length < count; attempt += 1) {
    await sleep(50)
  }
  assert.equal(observed.created.length, count, `expected ${count} card deliveries`)
  return lastDelivered()
}

/**
 * Drive one session to a finished turn, so a result notice is offered.
 * @param emit - the `session/event` listener.
 * @param id - session id.
 */
function runTurn(emit, id) {
  emit({ id }, { type: 'user/message', data: { source: { kind: 'user' } } })
  emit({ id }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: '改好了。' }] } },
  })
  emit({ id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

test('a deployment that never moved sides keeps the configured head start', async () => {
  const { route, state, listenerOf } = await scaffold({ delaySeconds: 300 })
  await bind(route)
  assert.equal((await state()).priority, 'desk', 'it starts at the desk')

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)
  await sleep(300)
  assert.equal(observed.created.length, 0, 'and the configured wait is what holds a card back')
  desktop.resolve('rejected')
})

test('answering a card from the phone moves the side to the phone', async () => {
  const { route, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')

  // Nobody ever answers at the desk, which is the case the feature exists for.
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(1100)
  await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
  assert.equal((await state()).priority, 'phone', 'an answer from a card is a person at the phone')
})

test('answering a card mid-question is enough on its own', async () => {
  const { route, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const questions = listenerOf('user-questions/request')

  void questions.handler({
    questions: [
      { id: 'a', question: 'A?', options: [{ label: 'a1' }] },
      { id: 'b', question: 'B?', options: [{ label: 'b1' }] },
    ],
    signal: new AbortController().signal,
  }, () => Promise.withResolvers().promise)
  await sleep(1100)
  await clickCard(callbackValues(sentCard()).find(value => value.q === 'a'))

  // Part-way through a card is already proof of where the person is: waiting for every
  // question to be answered before treating the next request as live would be too late.
  assert.equal((await state()).priority, 'phone', 'a partial answer is enough')
})

test('the phone having it means the next card does not wait', async () => {
  const { route, sections, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const section = sections.get('pocket-console')
  const approval = listenerOf('approval/request')

  // The desktop branch of this race is never answered, which is the situation this whole
  // feature is about: nobody is at the desk. Settling it would let it win the race and hand
  // the side back to the desk — correct behaviour, and not what is under test here.
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(1100)
  const card = sentCard()
  observed.created.length = 0
  await clickCard(callbackValues(card).find(value => value.v === 'allowed-once'))
  assert.equal((await state()).priority, 'phone', 'the phone has it')

  // The wait is put back to something long, and the side is what has to override it. That
  // is the whole promise: a person at the phone is not made to wait out a desk head start.
  section.change(layer => { layer.delaySeconds = 300 })
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(300)
  assert.equal(observed.created.length, 1, 'the card goes out without waiting out the head start')
})

test('an answer at the desk brings the head start back', async () => {
  const { route, sections, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const section = sections.get('pocket-console')
  const approval = listenerOf('approval/request')

  // First the phone takes over, from a race the desk never wins.
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(1100)
  await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
  assert.equal((await state()).priority, 'phone', 'the phone had it')

  // The desktop answers this one, which is the only proof that anybody is sitting there.
  section.change(layer => { layer.delaySeconds = 300 })
  const desktop2 = Promise.withResolvers()
  const answered = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop2.promise,
  )
  desktop2.resolve('rejected')
  assert.equal(await answered, 'rejected')
  await sleep(20)
  assert.equal((await state()).priority, 'desk', 'answering at the desk puts the head start back')

  // And it applies again: with the side back at the desk, the long wait holds a card back.
  observed.created.length = 0
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(300)
  assert.equal(observed.created.length, 0, 'and the head start is what holds the card back again')
})

test('a reply from a result card is a person at the phone too', async () => {
  const { route, state, listenerOf, agents } = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(route)
  agents.set('s_1', { status: 'idle', followup: () => {} })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_1')
  await sleep(1100)
  assert.equal((await state()).priority, 'desk', 'nothing has moved it yet')

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)
  const settled = await clickCard(submit, { [answer]: '接着补文档' })
  assert.equal(settled.toast.content, '已发送给 agent')
  assert.equal((await state()).priority, 'phone', 'a reply typed on the phone is a person at the phone')
})

test('the card says which wait is in force, and says there is none under phone priority', async () => {
  const first = await scaffold({ delaySeconds: 300 })
  await bind(first.route)
  const approval = first.listenerOf('approval/request')

  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)
  // The card cannot arrive under a long wait, so the sentence it would carry is read from
  // the second deployment below, where the wait is short — what is under test is the copy,
  // and it has to follow the side rather than the setting.
  await sleep(50)
  assert.equal(observed.created.length, 0, 'nothing goes out while the desk has the head start')
  desktop.resolve('rejected')

  const second = await scaffold({ delaySeconds: 1 })
  await bind(second.route)
  const approval2 = second.listenerOf('approval/request')
  const desktop2 = Promise.withResolvers()
  void approval2.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop2.promise)
  await sleep(1100)
  assert.match(JSON.stringify(sentCard()), /桌面 1 秒内未应答/, 'a card names the wait it is under')
  desktop2.resolve('rejected')
})

test('a desk answer that arrives after the phone settled it changes nothing', async () => {
  const { route, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')

  const desktop = Promise.withResolvers()
  const raced = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1100)
  await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
  assert.equal((await state()).priority, 'phone', 'the phone answered first')

  // The desk answers the same request afterwards — a page that was left open, a person who
  // came back and pressed the button the composer was still showing. That branch loses the
  // race it was part of, so it must not move the side: the phone is still where the person is.
  desktop.resolve('rejected')
  assert.equal(await raced, 'allowed-once', 'the phone answer is the one that settled it')
  await sleep(20)
  assert.equal((await state()).priority, 'phone', 'and a late desk answer does not take the side back')
})

test('a stored side is what a restart starts from', async () => {
  // Exactly what a restart finds: a record written by the process that saw the phone
  // answer. A person away must not be put back behind a desk head start by a restart.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const fresh = await scaffold({ delaySeconds: 300 }, { stored })
  assert.equal((await fresh.state()).priority, 'desk', 'a deployment with nothing stored is at the desk')

  const away = await scaffold({ delaySeconds: 300 }, { stored: { ...stored, priority: 'phone' } })
  assert.equal((await away.state()).priority, 'phone', 'one that stored the phone starts at the phone')

  const back = await scaffold({ delaySeconds: 300 }, { stored: { ...stored, priority: 'desk' } })
  assert.equal((await back.state()).priority, 'desk', 'and one that stored the desk starts at the desk')
})

test('a record the store cannot answer leaves the desk default in force', async () => {
  // A store that refuses must not fail the load, and must not invent a side: the documented
  // default is the desk, and a deployment that cannot read its state is at the desk.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const refused = await scaffold({ delaySeconds: 300 }, {
    stored: { ...stored, priority: 'not-a-side' },
  })
  assert.equal((await refused.state()).priority, 'desk', 'a value that names no side is ignored')
})

test('the side is written down when it moves, so a restart can find it', async () => {
  const { route, records, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')

  assert.equal(records.has(credentialKey('pocket-console', 'priority')), false, 'nothing is written until it moves')
  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)
  await sleep(1100)
  const settled = await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
  assert.equal(settled.toast.content, '已批准（仅本次）', 'the click is the answer this case is about')
  // Not settled at the desk: the point is what the phone answer wrote down.
  assert.deepEqual(
    records.get(credentialKey('pocket-console', 'priority')),
    { kind: 'grant', payload: { side: 'phone' } },
    'the move is durable, not only in memory',
  )
})

/**
 * Put the phone in charge, leaving the request that did it still open.
 *
 * The request that took the phone over keeps racing an unsettled desktop branch, because
 * answering it at the desk would immediately hand the side back — which is what the case about
 * coming back to the desk is for, and would spoil the others.
 * @param approval - the `approval/request` listener.
 * @param delaySeconds - the configured wait, short enough that the first card arrives.
 */
async function phoneHasIt(approval, delaySeconds = 1) {
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  const handle = await cardsArrived(1)
  await clickCard(callbackValues(cardFrom(handle)).find(value => value.v === 'allowed-once'))
}

test('a request that arrives while the phone has it skips the head start', async () => {
  const { route, sections, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')
  await phoneHasIt(approval)
  assert.equal((await state()).priority, 'phone', 'the phone has it')

  // The wait is put well out of reach, and the side is what has to override it — that is the
  // promise, and the request below is what measures it. Its card goes out at once rather than
  // after five minutes, because it skipped the head start instead of shortening it.
  sections.get('pocket-console').change(layer => { layer.delaySeconds = 300 })
  observed.created.length = 0
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await cardsArrived(1)
})

test('the desk return reaches only a request whose card never went out', () => {
  // The rule, checked directly. The window it governs is milliseconds wide — a card that skipped
  // the head start is committed as soon as the request arrives — so a case that had to slip a
  // person's answer into that window would be testing the harness's timing, not the rule.
  assert.equal(
    shouldReturnHeadStart({ noHeadStart: true, delivered: false, triggered: false }),
    true,
    'a request that skipped the head start and has not sent its card is owed one back',
  )
  assert.equal(
    shouldReturnHeadStart({ noHeadStart: false, delivered: false, triggered: false }),
    false,
    'one the desk actually let the clock run out on is the feature working, and keeps its card',
  )
  assert.equal(
    shouldReturnHeadStart({ noHeadStart: true, delivered: true, triggered: true }),
    false,
    'a card already on the phone stays there — two cards would ask one question twice',
  )
  assert.equal(
    shouldReturnHeadStart({ noHeadStart: true, delivered: false, triggered: true }),
    false,
    'and so does a card already on its way, which is neither delivered nor still waiting',
  )
})

test('a request still waiting when the desk returns gets its head start back', async () => {
  const { route, sections, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')

  // The phone takes over from a race the desk never wins.
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await cardsArrived(1)
  await clickCard(callbackValues(cardFrom(lastDelivered())).find(value => value.v === 'allowed-once'))
  assert.equal((await state()).priority, 'phone', 'the phone has it')

  // A long wait is configured, and a request arrives under phone priority — so its card is due to
  // go out at once, having skipped the head start entirely.
  sections.get('pocket-console').change(layer => { layer.delaySeconds = 300 })
  observed.created.length = 0
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )

  // Somebody is at the desk, and the answer arrives *within the same turn*: the zero-wait send has
  // been scheduled but has not run yet. This is the whole window this behaviour governs — a person
  // acting a second later is acting after the card is already committed — and it is why the rule is
  // also asserted on its own, above.
  const desktop = Promise.withResolvers()
  const deskAnswer = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  assert.equal(await deskAnswer, 'rejected', 'the desk answered its own request')
  assert.equal((await state()).priority, 'desk', 'the head start is back in force')

  // The phone's request had not gone out, so it is owed the head start — and now waits it out like
  // any other request, instead of the card arriving at once as it would have under the phone.
  await sleep(200)
  assert.equal(observed.created.length, 0, 'the recovered request waits the head start out')
})

test('typing at the desktop composer is a person at the desk', async () => {
  const { route, state, listenerOf, emitToAll } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')
  await phoneHasIt(approval)
  assert.equal((await state()).priority, 'phone', 'the phone has it')

  // What the browser's own submission looks like in the session log: a human message whose source
  // carries the request id the gateway's session controller stamped on it. That id is the whole
  // difference between a person typing at the desk and the several other producers of a
  // `{ kind: 'user' }` message — including this plugin's own phone-side instruction.
  emitToAll('session/event', { id: 's_1' }, {
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      source: { kind: 'user', rpcId: 'b2f1c0de-0000-4000-8000-000000000001' },
      content: [{ type: 'text', text: '接着把文档补完' }],
    },
  })
  await sleep(20)
  assert.equal((await state()).priority, 'desk', 'and the head start is back in force')
})

test('a message with no gateway id does not count as somebody at the desk', async () => {
  const { route, state, listenerOf, emitToAll } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')
  await phoneHasIt(approval)
  assert.equal((await state()).priority, 'phone', 'the phone has it')

  // The same shape minus the id, which is how every other producer writes one: this plugin's own
  // instruction from a result card, the headless and SDK entry points, and plugin-injected context.
  // Counting any of them as somebody at the desk would hand the head start back the moment a
  // person tapped a card on the phone — undoing the very thing that puts the phone in charge.
  for (const source of [{ kind: 'user' }, { kind: 'plugin', plugin: 'somewhere' }]) {
    emitToAll('session/event', { id: 's_1' }, {
      type: 'user/message',
      surfaceOp: 'append',
      data: { source, content: [{ type: 'text', text: '接着补文档' }] },
    })
  }
  await sleep(20)
  assert.equal((await state()).priority, 'phone', 'so the phone keeps it')
})

test('a request whose card already reached the phone is not disturbed', async () => {
  const { route, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const approval = listenerOf('approval/request')

  // Nobody answers at the desk, so the clock runs out and the card goes out with a real head
  // start behind it. That is the feature working, not an artifact of where the person happened
  // to be, so somebody coming back later must not mint a second card for the same request —
  // which would put one question in front of two surfaces.
  const waiting = Promise.withResolvers()
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => waiting.promise,
  )
  const handle = await cardsArrived(1)

  // The phone answers it, putting the phone in charge; then somebody answers a fresh request at
  // the desk, putting the desk back. The settled request is out of the registry by then, so
  // nothing can send a second card for it.
  await clickCard(callbackValues(cardFrom(handle)).find(value => value.v === 'allowed-once'))
  const desktop = Promise.withResolvers()
  const deskAnswer = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  await deskAnswer
  await sleep(200)
  assert.equal(observed.created.length, 1, 'no second card is minted for a settled request')
})
