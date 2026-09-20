/**
 * The activity card: what a run is doing, while it is doing it.
 *
 * The behaviours worth pinning are the ones a careless case would agree with without checking:
 * that no card appears while the desk holds the person, that a burst of deltas becomes one edit
 * rather than hundreds, that the card keeps the newest of the stream and nothing else, that it
 * carries nothing to press, and that it names its session.
 *
 * Two things about how these cases read the card:
 *
 * - Through {@link latestCard}, which takes the newest edit if there is one and the message
 *   otherwise. A delta can land before the first send completes, in which case the text goes out
 *   with the card — better than an edit behind it, and not something to assert against.
 * - After {@link settle}, which is longer than the refresh window. The card is edited on a
 *   trailing window, so reading it immediately would read the version from before the event.
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
} from './support/harness.mjs'

/** Wait past one refresh window, so the card reflects everything emitted before it. */
const settle = () => sleep(400)

/**
 * The card as it stands now.
 * @returns the newest card JSON the harness saw.
 */
function latestCard() {
  const newest = observed.patched.at(-1) ?? observed.created.at(-1)
  return JSON.parse(newest.data.content)
}

/**
 * How many activity cards this deployment has delivered.
 *
 * Counted by title rather than by delivery, because the escalation a case uses to take the
 * phone over is a card too, and it can land on either side of the moment the case clears the
 * log — which is a race about the harness, not about this card.
 * @returns the number of delivered activity cards.
 */
function activityCards() {
  return observed.created.filter((entry) => {
    try {
      return JSON.parse(entry.data.content).header.title.content.startsWith('DSH 执行中')
    } catch {
      return false
    }
  }).length
}

/**
 * Emit one text delta on the live stream, the way the model produces them.
 * @param emitToAll - the harness emitter.
 * @param session - session id.
 * @param text - the delta.
 */
function delta(emitToAll, session, text) {
  emitToAll('agent/assistant-stream', { agent: { id: session } }, {
    type: 'chunk',
    chunk: { type: 'text-delta', text },
  })
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
 * A deployment where the phone holds the person, ready for a run to be observed.
 * @param options - the scaffold options.
 * @returns the scaffold result, with the card log cleared.
 */
async function underPhonePriority(options = { delaySeconds: 1 }) {
  const scaffolded = await scaffold(options)
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  observed.created.length = 0
  observed.patched.length = 0
  return scaffolded
}

test('no activity card is sent while the desk holds the person', async () => {
  const { route, emitToAll } = await scaffold({ delaySeconds: 1 })
  await bind(route)

  emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  delta(emitToAll, 's_1', '正在检查。')
  await settle()

  // The desk is where this run is visible, so a card on the phone would be a message nobody
  // asked for — which is the one thing this plugin says it does not send.
  assert.equal(observed.created.length, 0, 'the desk having the person means no card')
})

test('a run under phone priority gets one card, and its text grows', async () => {
  const scaffolded = await underPhonePriority()
  const emit = scaffolded.emitToAll

  emit('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  delta(emit, 's_1', '先看一下')
  await settle()
  assert.equal(activityCards(), 1, 'the card is sent once')
  assert.equal(sentCard().header.template, 'blue', 'a run in progress is the calm colour')
  assert.match(JSON.stringify(latestCard()), /先看一下/, 'and carries the text so far')

  delta(emit, 's_1', '测试失败的那两个用例')
  await settle()
  // The card is a message that is rewritten, never a new message: sending again would notify,
  // and a card that announces itself on every paragraph is the noise this design avoids.
  assert.equal(activityCards(), 1, 'and it is never re-sent')
  assert.match(JSON.stringify(latestCard()), /先看一下测试失败的那两个用例/, 'the text grew in place')
})

test('a burst of deltas becomes one edit, not one edit per delta', async () => {
  const scaffolded = await underPhonePriority()
  const emit = scaffolded.emitToAll

  emit('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  observed.patched.length = 0

  // Sixty deltas in one burst, which is what a model writing a paragraph produces. Feishu
  // allows five edits a second to one message, so this has to collapse rather than be refused.
  for (let index = 0; index < 60; index += 1) delta(emit, 's_1', `第${index}段 `)
  await settle()

  assert.equal(observed.patched.length, 1, `sixty deltas in one window are one edit: ${observed.patched.length}`)
  assert.match(JSON.stringify(latestCard()), /第59段/, 'and the card carries the newest of them')
})

test('the card keeps the newest fragments and nothing else', async () => {
  const scaffolded = await underPhonePriority()
  const emit = scaffolded.emitToAll

  emit('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()

  for (const piece of ['一', '二', '三', '四', '五']) {
    delta(emit, 's_1', piece)
    await settle()
  }
  const content = JSON.stringify(latestCard())
  // The card shows the tail of the stream — what the model is writing now — not the whole
  // answer, which is what the result notice is for.
  assert.match(content, /三四五/, 'the newest three are what the card carries')
  assert.equal(content.includes('一'), false, 'and the older ones have been dropped')
})

test('a card carries nothing to press', async () => {
  const scaffolded = await underPhonePriority()
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()

  const card = latestCard()
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
  // Cleared after the takeover: the card that took the phone over is a card too, and this case
  // is about the activity card's own title.
  observed.created.length = 0
  observed.patched.length = 0

  scaffolded.emitToAll('session/event', { id: 's_ws' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()

  assert.equal(activityCards(), 1, 'the activity card is what was sent')
  assert.equal(latestCard().header.title.content, 'DSH 执行中 · my-app', 'and its title names the workspace')
})

test('the card says what the run is doing, and stops saying it when the turn ends', async () => {
  const scaffolded = await underPhonePriority()
  const emit = scaffolded.emitToAll

  emit('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  delta(emit, 's_1', '看一下')
  await settle()
  assert.match(JSON.stringify(latestCard()), /处理中/, 'a running step says so')
  assert.equal(JSON.stringify(latestCard()).includes('undefined'), false, 'and nothing reads as undefined')

  emit('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, callId: 'c1', name: 'npm test' },
  })
  await settle()
  assert.match(JSON.stringify(latestCard()), /npm test/, 'a tool call is named')
  assert.match(JSON.stringify(latestCard()), /等待工具/, 'and the status says what it waits on')

  emit('session/event', { id: 's_1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await settle()
  assert.match(JSON.stringify(latestCard()), /已停止/, 'a finished turn stops claiming to run')
  assert.equal(JSON.stringify(latestCard()).includes('npm test'), false, 'and stops naming the tool')
})

test('a failed turn says so on the card, with the reason', async () => {
  const scaffolded = await underPhonePriority()
  const emit = scaffolded.emitToAll

  emit('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  emit('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'error', error: { message: '模型连接中断' } } },
  })
  await settle()

  // The reason is the one piece of detail worth the room on this card: it is what decides
  // whether the reader needs to do anything.
  assert.match(JSON.stringify(latestCard()), /出错/, 'the status names the failure')
  assert.match(JSON.stringify(latestCard()), /模型连接中断/, 'and the reason is on the card')
})
