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
import {
  sleep,
  clickCard,
  scaffold,
  bind,
  callbackValues,
  controlNames,
  sentCard,
  observed,
} from './support/harness.mjs'

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
