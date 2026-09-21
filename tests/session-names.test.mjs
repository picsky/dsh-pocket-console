/**
 * Every card says which session it belongs to, in the small line under its title.
 *
 * The title says what the card is and which project it belongs to — and a project with two sessions
 * running in it makes two identical titles, which is the thing a person on a phone cannot tell apart.
 * The session's own name is the only property that separates them, and the harness already gives every
 * session one: it appends a `session/title` event when the first human message arrives, when a
 * generator finishes, and when somebody renames the session.
 *
 * Read from the *sent card*, not from the view: what the platform receives is what a reader sees. The
 * field is asserted through the wire JSON because the shape is the contract — measured on the tenant,
 * `{ tag, content }` is accepted and a bare string is refused with `230099`, so a case that only
 * checked "the string is in there somewhere" would certify a card the platform rejects.
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
  cardsSent,
  lastDelivered,
} from './support/harness.mjs'

/** The name every case gives the session unless it is testing the absence of one. */
const NAME = '新会话任务与手机接管'

/** The small line, as the copy spells it. */
const LINE = `会话：${NAME}`

/** The title every activity card starts with. */
const ACTIVITY_TITLE = 'DSH 执行中'

/** The title every result card starts with. */
const RESULT_TITLE = 'DSH 结果'

/** The header of the card in one message. */
const headerOf = (card) => card?.header

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
  await clickCard(callbackValues(cardFrom(lastDelivered())).find(value => value.v === 'allowed-once'))
}

/**
 * A deployment where the phone holds the person and one session is watched.
 * @returns the scaffold result and the emitter for that session.
 */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
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
 * Emit one session title, the way the harness commits it.
 * @param scaffolded - the scaffold result.
 * @param title - the title text.
 */
const emitTitle = (scaffolded, title = NAME) => {
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'session/title',
    data: { title, messageSeqs: [], source: { kind: 'provider' } },
  })
}

/**
 * Drive one whole turn: the person speaks, the run answers, the turn ends.
 * @param scaffolded - the scaffold result.
 */
function turn(scaffolded) {
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把测试修好' }] },
  })
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '修好了。' }] } },
  })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

test('the result card names the session in the line under its title', async () => {
  const scaffolded = await phoneHoldsIt()
  emitTitle(scaffolded)
  turn(scaffolded)
  await sleep(1_500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.ok(result, 'the result came to the phone')
  const header = headerOf(result.card)
  assert.deepEqual(
    header.subtitle,
    { tag: 'plain_text', content: LINE },
    'the small line carries the session name, in the shape the platform accepts',
  )
  assert.match(header.title.content, /my-app/, 'and the title still names the project')
})

test('the activity card names the session too', async () => {
  const scaffolded = await phoneHoldsIt()
  emitTitle(scaffolded)
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  await sleep(500)

  const activity = cardsSent()
    .find(entry => String(entry.card?.header?.title?.content ?? '').startsWith(ACTIVITY_TITLE))
  assert.ok(activity, 'the run is shown')
  assert.deepEqual(headerOf(activity.card).subtitle, { tag: 'plain_text', content: LINE })
})

test('an approval card carries it as well', async () => {
  // Every card, not just the two the run produces: the point of the line is telling cards apart, and
  // an approval is the card somebody is most likely to be staring at while another session works.
  //
  // The request carries its agent, which is what a real one does — it is where the escalation finds
  // both the workspace and the session, and a fixture without it would quietly certify a card that
  // names neither.
  const scaffolded = await phoneHoldsIt()
  emitTitle(scaffolded)
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    {
      toolName: 'pwsh',
      signal: new AbortController().signal,
      agent: { session: { id: 's_1', header: { cwd: '/work/my-app' } } },
    },
    () => Promise.withResolvers().promise,
  )
  await sleep(1_100)

  const card = cardFrom(lastDelivered())
  assert.match(String(card?.header?.title?.content ?? ''), /工具审批/, 'the approval card went out')
  assert.deepEqual(headerOf(card).subtitle, { tag: 'plain_text', content: LINE })
})

test('a session with no name gets no small line at all', async () => {
  // The property that makes this safe to add: a session whose title this process never saw renders
  // the header it had before the field existed — no empty line, and no key either.
  const scaffolded = await phoneHoldsIt()
  turn(scaffolded)
  await sleep(1_500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.ok(result, 'the result still came to the phone')
  assert.equal('subtitle' in headerOf(result.card), false, 'and the header is exactly what it was')
})

test('a title that arrives after the card does is picked up by the next write', async () => {
  // The generator is asynchronous, so a card can exist before its session has a name. The activity
  // card is rewritten on every event of the run, which is what lets it catch up — so the case drives
  // the next event rather than the clock, and asserts the *second* version of the message, because
  // "the first write did not have it" is what makes this worth a case.
  const scaffolded = await phoneHoldsIt()
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  await sleep(500)

  const before = cardsSent()
    .find(entry => String(entry.card?.header?.title?.content ?? '').startsWith(ACTIVITY_TITLE))
  assert.ok(before, 'the run is shown before the session has a name')
  assert.equal('subtitle' in headerOf(before.card), false, 'with no small line yet')

  emitTitle(scaffolded)
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'step/start', data: { turn: 1, step: 2 } })
  await sleep(500)

  const after = cardFrom(before.handle)
  assert.deepEqual(
    headerOf(after).subtitle,
    { tag: 'plain_text', content: LINE },
    'and the name arrives on the same message once the session has one',
  )
})

test('a card for a session titled before this process started still names it', async () => {
  // The case the small line was missing from in the field: the session existed before the deployment
  // started, so its `session/title` event is already in the log and will never be appended again. The
  // name is read once from the harness's title service instead.
  const scaffolded = await phoneHoldsIt()
  scaffolded.titles.set('s_1', { title: NAME })
  turn(scaffolded)
  await sleep(1_500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.ok(result, 'the result came to the phone')
  assert.deepEqual(
    headerOf(result.card).subtitle,
    { tag: 'plain_text', content: LINE },
    'the name the service holds reaches the card with no event at all',
  )
})

test('a renamed session is re-labelled rather than frozen at its first name', async () => {
  const scaffolded = await phoneHoldsIt()
  emitTitle(scaffolded, '旧名字')
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  await sleep(500)

  emitTitle(scaffolded, '新名字')
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'step/start', data: { turn: 1, step: 2 } })
  await sleep(500)

  const activity = cardsSent()
    .find(entry => String(entry.card?.header?.title?.content ?? '').startsWith(ACTIVITY_TITLE))
  assert.deepEqual(headerOf(cardFrom(activity.handle)).subtitle, {
    tag: 'plain_text',
    content: '会话：新名字',
  })
})

test('a title that is not one line is made into one', async () => {
  const scaffolded = await phoneHoldsIt()
  emitTitle(scaffolded, '  两行\n名字\t带空白  ')
  turn(scaffolded)
  await sleep(1_500)

  const result = cardsSent()
    .filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))
    .at(-1)
  assert.deepEqual(headerOf(result.card).subtitle, {
    tag: 'plain_text',
    content: '会话：两行 名字 带空白',
  })
})
