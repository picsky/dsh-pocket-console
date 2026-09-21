/**
 * A session a run delegated to never gets a card of its own.
 *
 * Measured on a real deployment: one instruction that fanned out to two subagents put four cards on
 * the phone — two activity cards in the *same millisecond*, both of them ringing, and then a result
 * card per delegate as each turn ended. All of them described the one execution the person had asked
 * for, which is why they read as duplicates.
 *
 * Both producers were asking the wrong question. A delegate's prompt is delivered as a
 * `{ kind: 'user' }` message — the exact shape a person's own message has, minus the `rpcId` only a
 * desk keystroke carries — so a test of that field let every delegate through. The session's own
 * creation header is what answers it: `origin` is a declared field the harness refuses to set to
 * anything but `"subagent"`, and it is there whether or not this process saw the session start.
 *
 * The cases below are written as pairs — the delegate and the asking session under the same events —
 * because "no card was sent" is also what a deployment that stopped sending cards looks like.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isDelegated } from '../delegated.js'
import {
  sleep,
  clickCard,
  scaffold,
  bind,
  callbackValues,
  observed,
  lastDelivered,
  cardFrom,
  cardTitled,
  controlNames,
} from './support/harness.mjs'

/** Wait past one refresh window, so a card reflects everything emitted before it. */
const settle = () => sleep(400)

/** The titles that name the two cards this plugin sends about a run. */
const ACTIVITY_TITLE = 'DSH 执行中'
const RESULT_TITLE = 'DSH 结果'

/** The activity card this deployment has sent, if it has sent one. */
const activityCard = () => cardTitled(ACTIVITY_TITLE)

/** The result card this deployment has sent, if it has sent one. */
const resultCard = () => cardTitled(RESULT_TITLE)

/**
 * A delegated session, as the firehose reports one: the header is the whole of the signal.
 * @param id - the session id.
 * @param parent - the session that asked for it.
 * @returns the session.
 */
const delegatedSession = (id, parent = 's_1') => ({
  id,
  header: { origin: 'subagent', parentSession: parent, cwd: '/work/my-app' },
})

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
 * @returns the scaffold result.
 */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  return scaffolded
}

/**
 * Drive one complete run through the session feed: a person asks, the agent answers, the turn ends.
 * @param scaffolded - the scaffold result.
 * @param session - the session, as the firehose reports it.
 * @param answer - what the run says before it stops.
 */
function runTurn(scaffolded, session, answer = '改完了，测试也过了。') {
  const emit = (event) => scaffolded.emitToAll('session/event', session, event)
  emit({ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这两个 shard 做完' }] } })
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: answer }] } } })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

test('a delegated session is told apart by its header, and a fork is not', () => {
  assert.equal(isDelegated(delegatedSession('s_sub')), true, 'a subagent is delegated')

  // The deliberate part of the rule: a fork carries a parent too, and a fork is a conversation
  // somebody is having at the desk — silencing it would take the phone away from a real session.
  assert.equal(isDelegated({ id: 's_fork', header: { parentSession: 's_1' } }), false, 'a fork is not')
  assert.equal(isDelegated({ id: 's_1', header: { cwd: '/work/my-app' } }), false, 'an ordinary session is not')
  assert.equal(isDelegated({ id: 's_1' }), false, 'and a session with no header keeps its card')
  assert.equal(isDelegated(undefined), false, 'as does nothing at all')
})

test('a delegated run gets no activity card, while the run that asked for it does', async () => {
  const scaffolded = await phoneHoldsIt()

  const sub = delegatedSession('s_sub')
  scaffolded.emitToAll('session/event', sub, { type: 'turn/start', data: { turn: 1 } })
  scaffolded.emitToAll('session/event', sub, { type: 'tool/call', data: { turn: 1, step: 1, name: 'pwsh' } })
  await settle()

  assert.equal(activityCard(), undefined, 'the delegate is not followed, so nothing is minted for it')

  // The control: the same events for the session a person started still make a card, so this case is
  // about the delegate rather than about a deployment that has stopped sending cards.
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  await settle()
  assert.ok(activityCard(), 'the asking session keeps its card')
})

test('the phone taking over mints one card, not one per delegate in flight', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)

  // The reported bug in the shape it arrives: a person's session, and two subagents it delegated to,
  // all running when the phone takes the person over. Every one of them used to be taken on, so three
  // cards were created within a millisecond of each other and every one of them rang.
  scaffolded.agents.set('s_1', { status: 'running', session: { header: { cwd: '/work/my-app' } } })
  scaffolded.agents.set('s_sub_a', { status: 'running', session: { header: { origin: 'subagent', cwd: '/work/my-app' } } })
  scaffolded.agents.set('s_sub_b', { status: 'running', session: { header: { origin: 'subagent', cwd: '/work/my-app' } } })
  await takeOverFromThePhone(scaffolded)
  await settle()

  const shown = (await scaffolded.state()).activity
  assert.equal(shown.tracked, 1, `one session is followed, not three: ${JSON.stringify(shown.order)}`)
  assert.deepEqual(shown.order, ['s_1'], 'and it is the session a person started')

  const minted = scaffolded.cardsSent().filter(
    entry => entry.card?.header?.title?.content?.startsWith(ACTIVITY_TITLE),
  )
  assert.equal(minted.length, 1, `one card rings, not one per session in flight: ${minted.length}`)
})

test('a delegated turn ends without a result card of its own', async () => {
  const scaffolded = await phoneHoldsIt()
  // Everything the notice path needs, for both sessions: a log to read and an agent that is idle.
  for (const id of ['s_sub', 's_1']) {
    scaffolded.sessionQuery.exists(id, 5)
    scaffolded.agents.set(id, { status: 'idle', followup: () => {} })
  }
  observed.created.length = 0

  runTurn(scaffolded, delegatedSession('s_sub'))
  await sleep(1_400)
  assert.equal(resultCard(), undefined, 'the delegate reports through the session that asked for it')

  // The control, and the thing a reader would lose if the rule were drawn any wider.
  runTurn(scaffolded, { id: 's_1' })
  await sleep(1_400)
  assert.ok(resultCard(), 'and the asking session is still reported')
})

test('a notice stored for a delegate is retired when it comes back', async () => {
  // A card sent before this rule existed is still in the durable store, and nothing follows that
  // session any more — so it can never be written again. Left standing it would take a reply into a
  // card nobody moves, which is why restore retires it like any other notice that cannot be honoured.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.sessionQuery.exists('s_sub', 5)
  first.agents.set('s_sub', { status: 'idle', followup: () => {} })
  runTurn(first, { id: 's_sub' })
  await sleep(1_100)

  const card = cardTitled(RESULT_TITLE)
  assert.ok(card, 'the first deployment sent the notice this case is about')
  const submit = callbackValues(card.card).find(value => value.submit === true)
  const [answer] = controlNames(card.card)

  // The restart, without the storage service: the restore has nothing to read yet, which is what
  // leaves the window a case needs to make the session known as delegated before it opens.
  const second = await scaffold(
    { resultNotify: 'idle' },
    { stored, keepDurable: true, services: ['settings', 'webServer', 'sessionQuery', 'sessionController', 'sessionTitle'] },
  )
  second.agents.set('s_sub', { status: 'idle', session: { header: { origin: 'subagent' } } })
  second.compose('storageDomain')
  await sleep(50)

  const retired = observed.patched.at(-1)
  assert.ok(retired, 'the card came back and was rewritten')
  assert.match(retired.data.content, /这个会话是被委派的/,
    'and it says why, rather than pretending the result expired')
  assert.deepEqual(callbackValues(JSON.parse(retired.data.content)), [],
    'no reply is offered from a card this side will never move again')

  const refused = await clickCard(submit, { [answer]: '接着做' })
  assert.notEqual(refused.toast.content, '已发送给 agent', 'and the stale reply cannot reach the session')
})
