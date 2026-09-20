/**
 * Starting a new task from the phone: where the offer appears, what it inherits, and what a press
 * does to the session it starts.
 *
 * The offer rides on the result card rather than a card of its own. A result already ends on
 * "what now?", and a separate card asking that question was one more notification for the same run
 * — the cost this plugin spends the most care on. Three properties are worth more than the rest,
 * and all three fail silently if they are wrong:
 *
 * - **The new session inherits the asking session's workspace.** A new task started against the
 *   deployment's default directory is work in the wrong project, and nothing about the card would
 *   look wrong.
 * - **The first prompt does not carry a gateway request id.** That id is what the deployment reads
 *   as "somebody typed at the desk", so a phone-started task carrying one would hand the head start
 *   back and undo phone priority.
 * - **Using the offer does not destroy the answer.** The card is a result first; a rewrite that
 *   closed it by replacing the whole face would take away the text the reader came back for.
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

/** The title the standalone new-task card used to carry. Nothing should ever bear it again. */
const OLD_WORK_TITLE = 'DSH 新任务'

/** The result card this deployment has sent, which is where the offer lives. */
const resultCard = () => cardTitled('DSH 结果')

/**
 * The control the next task's text goes in.
 *
 * Read off the card rather than assumed, and picked by the name the *offer* reported rather than by
 * position: a result card carries two forms — the reply box and this one — and the channel is free
 * to name either however it likes. Taking the first control would type a new task into the reply
 * box, which is a different card answering a different question.
 * @param card - the rendered result card.
 * @returns the control name for the new task's text.
 */
const workField = (card) => {
  const submit = callbackValues(card).find(value => value.work === 'work-start')
  const name = submit?.submits?.workText
  assert.ok(typeof name === 'string', 'the offer reports which control carries the new task')
  assert.ok(
    controlNames(card).includes(name),
    'and that control is on the card: ' + JSON.stringify(controlNames(card)),
  )
  return name
}

/**
 * Put the phone in charge, which is the only side a result — and so the offer — goes out on.
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
 * A deployment where the phone holds the person, with one finished run on the phone.
 * @param config - plugin config overrides.
 * @param host - which optional services the deployment composes.
 * @returns the scaffold result, the session-event emitter, and the result card's handle.
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
  return { scaffolded, emit, notice: resultCard() }
}

test('the result card carries the offer, and no second card is sent for it', async () => {
  const { notice } = await withAFinishedRun()
  assert.ok(notice, 'the result went to the phone')
  // The whole point of the change: one run, one result message, and the offer inside it.
  assert.equal(resultCard().handle, notice.handle, 'the offer rides the result card itself')
  assert.equal(cardTitled(OLD_WORK_TITLE), undefined, 'and no separate new-task card exists')
  // Counted, not inferred from a title: the run's own messages are the thing the phone pays for.
  // `withAFinishedRun` clears the delivery log after the phone takes over, so what is left is
  // exactly what this run produced. The activity card is the other one, and it only exists when a
  // run is still going — this one is over.
  assert.equal(
    observed.created.length,
    1,
    'a finished run costs one notification, not two: ' + JSON.stringify(observed.created.map(request => request.data.content?.slice(0, 60))),
  )

  const card = JSON.stringify(notice.card)
  assert.match(card, /新会话/, 'the card says it can start a new session')
  assert.match(card, /my-app/, 'and names the workspace that session would inherit')
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
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

  // What could come next is something the desk can already see, and a card sent while somebody is
  // sitting there is the push this plugin says it does not do. The result still goes out, because
  // `resultNotify` is about the answer, not about the offer.
  const notice = resultCard()
  assert.ok(notice, 'the result still goes out')
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  assert.equal(submit, undefined, 'but nothing on it offers to start a task')
})

test('a press starts a session in the asking session\'s workspace, and prompts it', async () => {
  const { scaffolded, notice } = await withAFinishedRun()
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)

  const toast = await clickCard(submit, { [field]: '把剩下的两个 shard 做完' }, { messageId: notice.handle })
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
  const { scaffolded, notice } = await withAFinishedRun()
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)

  const toast = await clickCard(submit, { [field]: '   ' }, { messageId: notice.handle })
  assert.equal(toast.toast.content, '指令为空，未发送')
  assert.equal(scaffolded.sessionController.created.length, 0, 'nothing was started')
})

test('using the offer closes it without taking the answer away', async () => {
  const { notice } = await withAFinishedRun()
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)
  const handle = notice.handle

  await clickCard(submit, { [field]: '做完剩下的' }, { messageId: notice.handle })
  await sleep(30)

  // Left as a form it would invite a second press that starts a second session for one decision.
  const after = cardFrom(handle)
  assert.deepEqual(callbackValues(after), [], 'every control is gone, so nothing can be pressed twice')
  assert.match(JSON.stringify(after), /已开新会话/, 'the card says what it did')
  assert.match(JSON.stringify(after), /my-app/, 'and names the workspace it did it in')
  // The card is a result first. Closing it by replacing the face is the failure this case exists
  // for: the reader answers the offer, scrolls back, and the answer they were reading is gone.
  assert.match(JSON.stringify(after), /构建已经通过/, 'and the answer it was reporting is still there')
  // The offer's words go with the form it just lost. Text pointing at a control that is not on the
  // card is the same lie in a quieter form, and this is the second time this project has paid for it.
  const words = after.body.elements.map(element => element.content ?? '').join('\n')
  assert.equal(/开下一段|新会话里开/.test(words), false, 'and nothing still offers the form that is gone')
  assert.equal(/回复这条消息/.test(words), false, 'nor points at the reply box it took with it')
})

test('a second press on the same card starts nothing', async () => {
  const { scaffolded, notice } = await withAFinishedRun()
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)

  await clickCard(submit, { [field]: '做完剩下的' }, { messageId: notice.handle })
  await sleep(30)
  // A channel may keep showing the form after this side has rewritten the card, so the guard
  // cannot be the card's face — it has to be the message. Same text, same message, one session.
  const again = await clickCard(submit, { [field]: '做完剩下的' }, { messageId: notice.handle })
  assert.match(again.toast.content, /已经开过一次/, 'the reader is told why nothing happened')
  assert.equal(scaffolded.sessionController.created.length, 1, 'and no second session was started')
})

test('starting a task puts the new session on the phone\'s side', async () => {
  const { scaffolded, notice } = await withAFinishedRun()
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)
  await clickCard(submit, { [field]: '开始吧' }, { messageId: notice.handle })

  // The person is holding the phone, so the session they just started must not wait out a desk
  // head start — the same reason answering a card moves the side.
  assert.equal((await scaffolded.state()).priority, 'phone', 'the phone still has it')
})

test('a deployment with no session controller says so instead of failing', async () => {
  const { scaffolded, notice } = await withAFinishedRun({}, {
    services: ['settings', 'webServer', 'storageDomain', 'sessionQuery'],
  })
  assert.ok(notice, 'the offer still goes out')
  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)

  const toast = await clickCard(submit, { [field]: '做点什么' }, { messageId: notice.handle })
  assert.match(toast.toast.content, /没有会话控制器/, 'the reader is told why nothing happened')
  assert.equal(scaffolded.warnings.length > 0, true, 'and the deployment log says so too')
})

test('the task the phone starts does not count as somebody at the desk', async () => {
  const { scaffolded, notice } = await withAFinishedRun()
  const before = (await scaffolded.state()).priority
  assert.equal(before, 'phone', 'the phone had it')

  const submit = callbackValues(notice.card).find(value => value.work === 'work-start')
  const field = workField(notice.card)
  await clickCard(submit, { [field]: '接着做' }, { messageId: notice.handle })
  await sleep(30)

  // The prompt this plugin sends carries no gateway request id, so the desk-presence rule must not
  // fire on it. If it did, starting a task from the phone would immediately undo phone priority —
  // the silent failure this case exists to catch.
  assert.equal((await scaffolded.state()).priority, 'phone', 'and it still has it')
})
