/**
 * Starting a new task from the phone: when the offer appears, what it inherits, and what a press
 * does to the session it starts.
 *
 * The two properties worth more than the rest are here as cases of their own, because both fail
 * silently if they are wrong:
 *
 * - **The new session inherits the asking session's workspace.** A new task started against the
 *   deployment's default directory instead is work in the wrong project, and nothing about the card
 *   would look wrong.
 * - **The first prompt does not carry a gateway request id.** That id is what the deployment reads
 *   as "somebody typed at the desk", so a phone-started task carrying one would hand the head start
 *   back and undo phone priority.
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
  controlNames,
  observed,
  lastDelivered,
  cardFrom,
  cardTitled,
} from './support/harness.mjs'

/**
 * Drive one session through a finished turn, so a result notice is offered.
 * @param emit - the `session/event` listener.
 * @param id - session id.
 * @param answer - the answer text.
 * @param turn - which turn number it is.
 */
function runTurn(emit, id, answer = '构建已经通过。', turn = 1) {
  emit({ id }, { type: 'user/message', data: { source: { kind: 'user' } } })
  emit({ id }, { type: 'turn/start', data: { turn } })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn, message: { content: [{ type: 'text', text: answer }] } },
  })
  emit({ id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

/** The title every new-task card starts with, which no other card does. */
const WORK_TITLE = 'DSH 新任务'

/** The new-task card this deployment has sent, or undefined. */
const workCard = () => cardTitled(WORK_TITLE)

/**
 * Put the phone in charge, which is the only side a new-task card is offered on.
 * @param scaffolded - the scaffold result.
 */
async function phoneHoldsIt(scaffolded) {
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  for (let attempt = 0; attempt < 60 && observed.created.length < 1; attempt += 1) await sleep(50)
  const handle = lastDelivered()
  await clickCard(callbackValues(cardFrom(handle)).find(value => value.v === 'allowed-once'))
}

/**
 * A deployment where the phone holds the person, with a finished run and both cards on the phone.
 * @param config - plugin config overrides.
 * @param host - which optional services the deployment composes.
 * @returns the scaffold result, the session-event emitter, and the two cards' handles.
 */
async function withAFinishedRun(config = {}, host = {}) {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle', ...config }, host)
  await bind(scaffolded.route)
  scaffolded.agents.set('s_1', {
    status: 'idle',
    session: { header: { cwd: '/work/my-app' } },
    followup: () => {},
  })
  await phoneHoldsIt(scaffolded)
  observed.created.length = 0
  const emit = scaffolded.listenerOf('session/event').handler
  runTurn(emit, 's_1')
  await sleep(1_200)
  return { scaffolded, emit, notice: cardTitled('DSH 结果'), work: workCard() }
}

test('a finished run offers the next task, on the phone', async () => {
  const { work, notice } = await withAFinishedRun()
  assert.ok(notice, 'the result went to the phone')
  assert.ok(work, 'and so did the offer to start the next task')
  assert.match(JSON.stringify(work.card), /新会话/, 'which says it starts a new session')
  assert.match(JSON.stringify(work.card), /my-app/, 'and names the workspace it inherits')
  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  assert.ok(submit, 'the card carries the one action this module answers')
})

test('nothing is offered while the desk holds the person', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(scaffolded.route)
  scaffolded.agents.set('s_1', {
    status: 'idle',
    session: { header: { cwd: '/work/my-app' } },
    followup: () => {},
  })
  const emit = scaffolded.listenerOf('session/event').handler
  runTurn(emit, 's_1')
  await sleep(1_200)

  assert.ok(cardTitled('DSH 结果'), 'the result still goes out')
  // What could come next is something the desk can already see, and a card sent while somebody is
  // sitting there is the push this plugin says it does not do.
  assert.equal(workCard(), undefined, 'but no new-task card is pushed to the desk')
})

test('a press starts a session in the asking session\'s workspace, and prompts it', async () => {
  const { scaffolded, work } = await withAFinishedRun()
  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  const [field] = controlNames(work.card)

  const toast = await clickCard(submit, { [field]: '把剩下的两个 shard 做完' })
  assert.equal(toast.toast.content, '已发送给 agent', 'the press is accepted')

  const created = scaffolded.sessionController.created
  assert.equal(created.length, 1, 'one session was created')
  // The workspace comes from the session the card was about, never from the press.
  assert.equal(created[0].request.cwd, '/work/my-app', 'and it inherited the asking session\'s workspace')

  const agent = scaffolded.agents.get(created[0].id)
  assert.equal(agent.followed.length, 1, 'the first prompt was handed to the new session')
  assert.equal(agent.followed[0].content[0].text, '把剩下的两个 shard 做完')
  assert.deepEqual(
    agent.followed[0].source,
    { kind: 'user' },
    'human input, and with no gateway request id — which would read as somebody at the desk',
  )
})

test('an empty press starts nothing', async () => {
  const { scaffolded, work } = await withAFinishedRun()
  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  const [field] = controlNames(work.card)

  const toast = await clickCard(submit, { [field]: '   ' })
  assert.equal(toast.toast.content, '指令为空，未发送')
  assert.equal(scaffolded.sessionController.created.length, 0, 'nothing was started')
})

test('the card stops offering once it has been used', async () => {
  const { scaffolded, work } = await withAFinishedRun()
  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  const [field] = controlNames(work.card)
  const handle = work.handle

  await clickCard(submit, { [field]: '做完剩下的' })
  await sleep(30)

  // Left as a form it would invite a second press that starts a second session for one decision.
  const after = cardFrom(handle)
  assert.deepEqual(callbackValues(after), [], 'and it carries nothing left to press')
  assert.match(JSON.stringify(after), /已开新会话/, 'saying what it did')
  assert.match(JSON.stringify(after), /my-app/, 'and naming the workspace it did it in')
})

test('starting a task puts the new session on the phone\'s side', async () => {
  const { scaffolded, work } = await withAFinishedRun()
  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  const [field] = controlNames(work.card)
  await clickCard(submit, { [field]: '开始吧' })

  // The person is holding the phone, so the session they just started must not wait out a desk
  // head start — the same reason answering a card moves the side.
  assert.equal((await scaffolded.state()).priority, 'phone', 'the phone still has it')
})

test('a deployment with no session controller says so instead of failing', async () => {
  const { scaffolded, work } = await withAFinishedRun({}, {
    services: ['settings', 'webServer', 'storageDomain', 'sessionQuery'],
  })
  assert.ok(work, 'the offer still goes out')
  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  const [field] = controlNames(work.card)

  const toast = await clickCard(submit, { [field]: '做点什么' })
  assert.match(toast.toast.content, /没有会话控制器/, 'the reader is told why nothing happened')
  assert.equal(scaffolded.warnings.length > 0, true, 'and the deployment log says so too')})

test('the task the phone starts does not count as somebody at the desk', async () => {
  const { scaffolded, work } = await withAFinishedRun()
  const before = (await scaffolded.state()).priority
  assert.equal(before, 'phone', 'the phone had it')

  const submit = callbackValues(work.card).find(value => value.work === 'work-start')
  const [field] = controlNames(work.card)
  await clickCard(submit, { [field]: '接着做' })
  await sleep(30)

  // The prompt this plugin sends carries no gateway request id, so the desk-presence rule must not
  // fire on it. If it did, starting a task from the phone would immediately undo phone priority —
  // the silent failure this case exists to catch.
  assert.equal((await scaffolded.state()).priority, 'phone', 'and it still has it')
})
