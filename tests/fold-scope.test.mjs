/**
 * The folded record is the run a person started — that run, and nothing before it.
 *
 * Three properties, all read off the rendered card rather than off the view, because what a reader
 * sees is what the platform's foldable element holds:
 *
 * - **Scope.** The fold answers "what did the sentence I just sent do". It used to keep the run
 *   before it as well — the answer the reader was looking at when they replied, which the card face
 *   stops carrying once it becomes the run's card. Measured on a real session, that turned out to be
 *   72% of the fold, showing work the reader had already read and already answered, on a card whose
 *   heading is about this run. The run before is on the result card that reported it.
 * - **Boundary.** The boundary is a person speaking. The `turn/start` that opens a turn arrives
 *   *after* their message (session log, seq 449 before seq 452), and it is not a boundary at all: one
 *   sentence can take several turns — a subagent settling, a retry, a queued continuation — and every
 *   one of them is the rest of the same answer. Neither is a `user/message` nobody wrote.
 * - **Anchor.** The person's own line opens the fold and is the one line it marks.
 *
 * `run-record.js` draws the same boundary for the result card, so the two folds are about the same
 * run; the last case here holds them side by side.
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

/** One `session/event` emitter for the session these cases use. */
const emitter = (scaffolded) => (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)

/**
 * Emit one whole turn the way the session log records it: the person speaks, the run answers, it ends.
 *
 * The order is the log's, not this file's invention: the `turn/start` that opens a turn is appended
 * **before** the `user/message` it belongs to (measured: seq 449 and seq 452 in one real session).
 * A rule that drew its boundary at the turn instead of at the sentence would file the sentence under
 * the run it is not about — which is what the boundary case below is for.
 * @param scaffolded - the scaffold result.
 * @param n - the turn number.
 * @param said - what the person said.
 * @param answer - what the run answered.
 */
function turn(scaffolded, n, said, answer) {
  const emit = emitter(scaffolded)
  emit({ type: 'turn/start', data: { turn: n } })
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: said }] },
  })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: n, step: 1, message: { content: [{ type: 'text', text: answer }] } },
  })
  emit({ type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
}

test('the fold is the run the person last started, not the session so far', async () => {
  const scaffolded = await phoneHoldsIt()
  for (const n of [1, 2, 3]) {
    turn(scaffolded, n, `第${n}轮我说的话`, `第${n}轮的答复。`)
    await settle()
  }

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.ok(record, 'the frozen card folds its record')
  assert.match(record, /第3轮我说的话/, 'the run being read is the one the last sentence opened')
  assert.match(record, /第3轮的答复/, 'and what it did')
  assert.equal(record.includes('第2轮的答复'), false, 'the run before it is not beside it')
  assert.equal(record.includes('第1轮的答复'), false, 'nor anything earlier')
  assert.equal(record.includes('---'), false, 'and there is no boundary line to mistake for markdown')
})

test('the sentence that opened a run is the first line of the fold, and the only one marked', async () => {
  const scaffolded = await phoneHoldsIt()
  for (const n of [1, 2]) turn(scaffolded, n, `第${n}轮我说的话`, `第${n}轮的答复。`)
  await settle()

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.match(record, /\*\*你\*\*：第2轮我说的话/, 'their words are marked')
  assert.equal(/\*\*你\*\*：第1轮我说的话/.test(record), false, 'the sentence that opened the run before is not here')
  assert.equal(
    (record.match(/\*\*你\*\*：/g) ?? []).length,
    1,
    'exactly one line carries the mark',
  )
  assert.ok(
    record.indexOf('第2轮我说的话') < record.indexOf('第2轮的答复'),
    'and it stands before what it produced',
  )
})

test('a turn that opens with nobody speaking is the rest of the same run', async () => {
  // One sentence can take several turns: a retry, a queued continuation, a subagent settling and
  // waking the loop. Every one of them is the rest of the answer the person is waiting for, so none
  // of them starts a new run — which is also the boundary the result card's record draws.
  const scaffolded = await phoneHoldsIt()
  turn(scaffolded, 1, '把这两件事都做完', '第一件做完了。')
  await settle()

  const emit = emitter(scaffolded)
  emit({ type: 'turn/start', data: { turn: 2 } })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二件也做完了。' }] } },
  })
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await settle()

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.match(record, /把这两件事都做完/, 'the anchor is still the sentence that opened the run')
  assert.match(record, /第一件做完了/, 'the first turn is in the same fold')
  assert.match(record, /第二件也做完了/, 'and so is the turn after it')
  assert.equal(record.includes('---'), false, 'as one run, not two')
})

test('what the run was told is not a boundary', async () => {
  // A `user/message` nobody wrote — injected context, a subagent reporting that it settled, an
  // agent-to-agent message — is part of what this run was told. Drawing a boundary there used to
  // keep only the newest stretch, so the sentence that anchors the run could be dropped from its own
  // fold: two of them in one turn were enough, and the reader then had a record of work with no
  // record of what it was for.
  const scaffolded = await phoneHoldsIt()
  const emit = emitter(scaffolded)
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把测试修好' }] },
  })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '先看失败的用例。' }] } },
  })
  for (const notice of ['子代理 1 结算了', '子代理 2 结算了']) {
    emit({
      type: 'user/message',
      surfaceOp: 'append',
      data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: notice }] },
    })
  }
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '两边都回来了。' }] } },
  })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  const record = foldedRecord(cardTitled(ACTIVITY_TITLE).card)
  assert.match(record, /把测试修好/, 'the sentence that anchors the run survives')
  assert.match(record, /先看失败的用例/, 'and so does the work from before the notices')
  assert.match(record, /两边都回来了/, 'with the work after them')
  assert.equal(record.includes('---'), false, 'all of it one run')
})

test('the card a reply was typed on folds that reply’s run, and nothing from the run before it', async () => {
  // The reported bug, in the shape it arrives: a reply on the result card turns that message into the
  // run's card, and the fold it then carries used to lead with the run the reader had just answered.
  const scaffolded = await phoneHoldsIt({ resultNotify: 'idle' })
  turn(scaffolded, 1, '第一件事：把测试修好', '第一件的答复。')
  await sleep(1500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.ok(result, 'the first run reported itself')
  const reply = callbackValues(result.card).find(value => value.submit === true)
  assert.ok(reply, 'with a box to reply in')

  await clickCard(reply, { [reply.submits.value]: '第二件事：把文档补上' }, { messageId: result.handle })
  await sleep(50)
  turn(scaffolded, 2, '第二件事：把文档补上', '第二件的答复。')
  await settle()

  const record = foldedRecord(cardFrom(result.handle))
  assert.ok(record, 'the card the reply came from folds the run it started')
  assert.match(record, /第二件事：把文档补上/, 'this run’s sentence is there')
  assert.match(record, /第二件的答复/, 'and what it did')
  assert.equal(record.includes('第一件的答复'), false, 'nothing of the run the reply was made against')
  assert.equal(record.includes('---'), false, 'and no boundary line that reads like markdown')
})

test('the result card folds the same run, and marks the person’s line the same way', async () => {
  const scaffolded = await phoneHoldsIt({ resultNotify: 'idle' })
  turn(scaffolded, 1, '把测试修好', '修好了。')
  turn(scaffolded, 2, '再把文档补上', '补好了。')
  await sleep(1500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.ok(result, 'the result came to the phone')
  const record = foldedRecord(result.card)
  assert.match(record, /思考过程/, 'under the result card’s own label')
  assert.match(record, /\*\*你\*\*：再把文档补上/, 'the person’s line is marked here too')
  assert.match(record, /补好了/, 'and the run is there')
  assert.equal(record.includes('修好了'), false, 'while the run before it is not — the same scope as the other card')
})
