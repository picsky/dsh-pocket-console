/**
 * The folded record is about **this** turn, and it marks the one line that is a person's.
 *
 * Two properties, both read off the rendered card rather than off the view, because what a reader
 * sees is what the platform's foldable element holds:
 *
 * - **Scope.** The card a person answered becomes the run's card, so its fold answers "what did the
 *   sentence I sent do". A running history of the session would show them work they have already
 *   read on the result cards of earlier turns.
 * - **Boundary.** The turn boundary is the person speaking. The `turn/start` that opens a turn
 *   arrives *after* their message, so a boundary drawn there files their sentence under the work it
 *   is not about.
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
  cardFrom,
  cardTitled,
  cardsSent,
  lastDelivered,
} from './support/harness.mjs'

/** Wait past one refresh window, so the card reflects everything emitted before it. */
const settle = () => sleep(400)

/** The title every activity card starts with, which no other card does. */
const ACTIVITY_TITLE = 'DSH 执行中'

/** The title every result card starts with. */
const RESULT_TITLE = 'DSH 结果'

/** The fold a card carries, as one string, or undefined when it has none. */
function foldedRecord(card) {
  const panel = (card?.body?.elements ?? []).find(element => element.tag === 'collapsible_panel')
  if (panel === undefined) return undefined
  return [
    panel.header?.title?.content,
    ...(panel.elements ?? []).map(element => element.content),
  ].filter(part => part !== undefined).join('\n')
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
  const card = cardFrom(lastDelivered())
  await clickCard(callbackValues(card).find(value => value.v === 'allowed-once'))
}

/**
 * A deployment where the phone holds the person.
 * @param config - extra plugin config.
 * @returns the scaffold result.
 */
async function phoneHoldsIt(config = {}) {
  const scaffolded = await scaffold({ delaySeconds: 1, ...config })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  scaffolded.agents.set('s_1', {
    status: 'idle',
    followup: () => {},
    session: { header: { cwd: '/work/my-app' } },
  })
  return scaffolded
}

/**
 * Emit one whole turn the way the session records it: the person speaks, the run answers, it ends.
 *
 * The order matters and is not this file's invention: `user/message` arrives **before** the
 * `turn/start` that opens the turn it belongs to.
 * @param scaffolded - the scaffold result.
 * @param n - the turn number.
 * @param said - what the person said.
 * @param answer - what the run answered.
 */
function turn(scaffolded, n, said, answer) {
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: said }] },
  })
  emit({ type: 'turn/start', data: { turn: n } })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: n, step: 1, message: { content: [{ type: 'text', text: answer }] } },
  })
  emit({ type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
}

test('the fold is this turn and the one before it, not the session so far', async () => {
  const scaffolded = await phoneHoldsIt()
  for (const n of [1, 2, 3]) {
    turn(scaffolded, n, `第${n}轮我说的话`, `第${n}轮的答复。`)
    await settle()
  }

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.ok(record, 'the frozen card folds its record')
  assert.equal(record.split('---').length, 2, 'two groups: the turn before, and this one')
  assert.equal(record.includes('第1轮的答复'), false, 'the turn before that is gone')
  assert.match(record, /第2轮的答复/, 'the turn before this one is kept')
  assert.match(record, /第3轮的答复/, 'and this one is the newest')
})

test('the sentence that opened a turn is in that turn’s group, not the one before it', async () => {
  const scaffolded = await phoneHoldsIt()
  for (const n of [1, 2, 3]) {
    turn(scaffolded, n, `第${n}轮我说的话`, `第${n}轮的答复。`)
    await settle()
  }

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  const [before, now] = record.split('---')
  assert.equal(
    /第3轮我说的话/.test(before),
    false,
    'the sentence that opened this turn is not filed under the previous one',
  )
  assert.match(now, /第3轮我说的话/, 'it opens its own group')
  assert.ok(
    now.indexOf('第3轮我说的话') < now.indexOf('第3轮的答复'),
    'and stands before what it produced',
  )
})

test('the sentence that opened the session is in the fold at all', async () => {
  // The record is built on the way in, so a session whose first event is a person speaking still has
  // their sentence: the `turn/start` that follows cannot restore what was never recorded.
  const scaffolded = await phoneHoldsIt()
  turn(scaffolded, 1, '第一句：把测试修好', '看完了。')
  await settle()

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.match(record, /第一句：把测试修好/, 'the opening sentence is kept')
  assert.equal(record.includes('---'), false, 'and one turn means no boundary line')
})

test('a turn that opens with nobody speaking closes the previous group too', async () => {
  // A turn can also open with no person's message between — a retry, a queued
  // continuation. The boundary is the person speaking *or* a turn opening while
  // the record is settled: without the second half, that group would stay open
  // and the two turns would read as one in the fold.
  const scaffolded = await phoneHoldsIt()
  turn(scaffolded, 1, '第一轮', '答复一。')
  await settle()
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
  emit({ type: 'turn/start', data: { turn: 2 } })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '答复二。' }] } },
  })
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await settle()

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.equal(record.split('---').length, 2, 'two groups: the previous turn, and this one')
  assert.match(record, /答复一/, 'the previous turn is closed as its own group')
  assert.match(record, /答复二/, 'and this one is separate')
})

test('a person’s own line is the one the fold marks', async () => {
  const scaffolded = await phoneHoldsIt()
  turn(scaffolded, 1, '把测试修好', '我先看失败的用例。')
  await settle()

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.match(record, /\*\*你\*\*：把测试修好/, 'their words are marked')
  assert.equal(/\*\*你\*\*：我先看失败的用例/.test(record), false, 'and the run’s are not')
  assert.equal(
    (record.match(/\*\*你\*\*：/g) ?? []).length,
    1,
    'exactly one line carries the mark',
  )
})

test('the result card folds one run, and marks the person’s line the same way', async () => {
  const scaffolded = await phoneHoldsIt({ resultNotify: 'idle' })
  turn(scaffolded, 1, '把测试修好', '修好了。')
  await sleep(1500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.ok(result, 'the result came to the phone')
  const record = foldedRecord(result.card)
  assert.match(record, /思考过程/, 'under the result card’s own label')
  assert.match(record, /\*\*你\*\*：把测试修好/, 'the person’s line is marked here too')
  assert.match(record, /修好了/, 'and the run is there')
})
