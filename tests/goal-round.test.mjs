/**
 * A goal's automatic rounds, on the phone.
 *
 * A goal keeps a session working after a round ends, and nothing about that reached the phone:
 * `dsh-goal-round-driver` opens each next round the moment the agent goes idle, with a
 * `<goal_round>` prompt whose source is `{ kind: 'goal' }`
 * (`dsh-goal-round-driver/lib/index.js:123-154`, `:134-142`). Every card key in this plugin read
 * "a person spoke" — `results.js` set its eligible flag only for `{ kind: 'user' }`, and `activity.js`
 * dropped every event on a settled record except a person's own message — so a round that a machine
 * started moved nothing, and a reader could not tell a session that was still working from one that
 * had stopped.
 *
 * What these cases pin, and how:
 *
 * - The **activity card** is read through `cardTitled`, by the handle it lives in, and the assertion
 *   is that the goal round *edited that message* rather than sending another: one card per session is
 *   this module's promise, and a goal round is not a reason to break it.
 * - The **result card** is read the same way, and the negative assertions matter as much as the
 *   positive ones: a card that reports a goal round must not offer the next task, because an offer to
 *   start something else is what "this is finished" reads like — the belief that had a reader type
 *   into a session that was still working.
 * - The **three silent transitions** are driven by the goal domain's own event, `goal/changed`, with
 *   no session event at all: that is the shape in which they arrive on a real deployment, and the
 *   only shape that proves the card is not simply waiting for the next turn.
 * - The goal service is a stand-in held to the Host's contract — it answers only for the registry's
 *   live agent and throws otherwise (`dsh-goal/lib/index.js:767`) — and the last case runs the same
 *   sequence on a deployment **without** the panel, where every card has to be exactly what it was
 *   before any of this existed.
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
  observed,
  lastDelivered,
  cardFrom,
  cardTitled,
} from './support/harness.mjs'

/** Wait past one refresh window, so the card reflects everything emitted before it. */
const settle = () => sleep(400)

/** The title every activity card starts with, which no other card does. */
const ACTIVITY_TITLE = 'DSH 执行中'

/** The title every result card starts with, which no other card does. */
const RESULT_TITLE = 'DSH 结果'

/**
 * The services a card deployment needs, plus the goal panel.
 *
 * Spelled out rather than defaulted, the way every other case that needs a service names it: the
 * harness composes nothing a case did not ask for, which is what keeps the deployment without a goal
 * panel the ordinary one.
 */
const SERVICES = [
  'settings', 'webServer', 'storageDomain', 'sessionQuery', 'sessionController', 'sessionTitle', 'goals',
]

/** The objective these cases work toward, which is what a card has to name. */
const OBJECTIVE = '把发布流程整理成文档'

/**
 * One goal view, the way the host's projection reports it (`GoalView`,
 * `dsh-goal/lib/typert.host.js:726`).
 * @param overrides - the fields this case is about.
 * @returns the view.
 */
function goalView({
  round = 2,
  maxRounds = 5,
  phase = 'active',
  activation = 'armed',
  objective = OBJECTIVE,
} = {}) {
  return {
    id: 'goal-1',
    revision: 3,
    phase,
    activation,
    objective,
    maxGoalRounds: maxRounds,
    roundsStarted: round,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  }
}

/**
 * The message the driver opens one round with.
 *
 * The event carries the message itself and no turn: the loop appends a claimed message as
 * `session.append('user/message', message)`, and the turn it will run in is announced afterwards by
 * `turn/start` (`dsh-agent-loop/lib/index.js:1046`). A case that put a turn on it would certify a
 * shape the deployment never produces — and the card modules read the turn from `turn/start` for
 * exactly that reason.
 *
 * The text is the driver's own prompt, kept verbatim enough to prove it never reaches a card: what a
 * card shows about a goal comes from the service, not from reading this back
 * (`dsh-goal-round-driver/lib/index.js:11-18`).
 * @param round - the round number.
 * @param max - the goal's cap, as the prompt spells it.
 * @returns the event.
 */
function goalRound(round, max = 5) {
  return {
    type: 'user/message',
    data: {
      source: { kind: 'goal', goalId: 'goal-1', revision: 3, round },
      content: [{
        type: 'text',
        text: `<goal_round>\nObjective: "${OBJECTIVE}"\nRound: ${round}/${max}\n\nContinue working toward the objective in this same session.\n</goal_round>`,
      }],
    },
  }
}

/** One message the run said, committed to the surface. */
const said = (turn, text) => ({
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { turn, message: { content: [{ type: 'text', text }] } },
})

/** The card JSON of one message, as text, so a case can assert over everything it carries. */
const textOf = (handle) => JSON.stringify(cardFrom(handle))

/** The activity card this deployment has sent, with the handle it lives in. */
const activityCard = () => cardTitled(ACTIVITY_TITLE)

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
 * A deployment where the phone holds the person and the goal panel is composed.
 * @param options - the rest of the scaffold options.
 * @returns the scaffold result.
 */
async function goalDeployment(options = {}) {
  const scaffolded = await scaffold({ delaySeconds: 1 }, { services: SERVICES, ...options })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  return scaffolded
}

/**
 * A session with an active goal and an agent that is between rounds.
 * @param scaffolded - the scaffold result.
 * @param view - the goal view to publish.
 * @returns the action the session's events are emitted through.
 */
function liveGoal(scaffolded, view = goalView()) {
  scaffolded.agents.set('s_1', { status: 'idle', followup: () => {} })
  scaffolded.goals.set('s_1', view)
  return (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
}

/**
 * The run a person started, finished, so the card is settled before the round arrives.
 * @param emit - the emit helper for the session.
 */
function humanRun(emit) {
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '开始吧' }] } })
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit(said(1, '第一轮做完了。'))
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/** One complete round the driver started, as the log records it. */
function machineRun(emit, round, { question = false } = {}) {
  emit(goalRound(round))
  emit({ type: 'turn/start', data: { turn: 8 + round } })
  if (!question) emit(said(8 + round, `第 ${round} 轮做完了。`))
  emit({ type: 'turn/end', data: { turn: 8 + round, reason: { kind: 'completed' } } })
}

test('a goal round moves the card that is already on the phone', async () => {
  const scaffolded = await goalDeployment()
  const emit = liveGoal(scaffolded, goalView({ round: 1 }))
  humanRun(emit)
  await settle()

  const before = activityCard()
  assert.ok(before, 'the run a person started has a card')
  assert.match(textOf(before.handle), /已结束/, 'and it says that run is over')

  // The driver's round, exactly as the session log records one. Nothing about the goal state is
  // emitted beside it: the round message is the only thing a card gets to notice.
  scaffolded.goals.set('s_1', goalView({ round: 2 }))
  machineRun(emit, 2)
  await settle()

  const after = activityCard()
  assert.equal(after.handle, before.handle, 'the round moves the card that is there, it does not send another')
  const text = textOf(after.handle)
  assert.match(text, /目标进行中 · 第 2\/5 轮（自动继续）/, 'the card says what the goal is doing')
  assert.match(text, new RegExp(OBJECTIVE), 'and which goal it is')
  assert.doesNotMatch(text, /已结束/, 'and it no longer reads as a session that stopped')
  // The prompt is the driver's own words to the model. A card that shows them would be putting a
  // machine's instruction on the phone as something the reader said — the one mark the fold has.
  assert.doesNotMatch(text, /goal_round/, 'the driver’s prompt is not carried as a person’s message')
})

test('the round a machine started is reported as a goal still in progress', async () => {
  const scaffolded = await scaffold({ resultNotify: 'idle' }, { services: SERVICES })
  await bind(scaffolded.route)
  const emit = liveGoal(scaffolded)

  // No person speaks in this session as far as this process has seen: the goal was armed before the
  // deployment restarted, so the human turn that made it is behind the process's own map. The round is
  // still work a reader is waiting on, and a report keyed on "a person spoke" would say nothing at all.
  machineRun(emit, 2)
  await sleep(1100)

  const shown = cardTitled(RESULT_TITLE)
  assert.ok(shown, 'a goal round is a turn that ends, and it is reported')
  const text = textOf(shown.handle)
  assert.match(text, /目标进行中 · 第 2\/5 轮（自动继续）/, 'and the card leads with where the goal stands')
  assert.match(text, new RegExp(OBJECTIVE), 'naming the goal it is about')
  assert.match(text, /第 2 轮做完了。/, 'the round’s own words are the answer under it')
  // The next-task offer is what "this is finished" reads like, and the goal's own machinery is what
  // decides what comes next.
  assert.doesNotMatch(text, /开下一段/, 'a goal round is not offered a next task')
  assert.doesNotMatch(text, /开始新任务/, 'and carries no control that would start one')
})

test('a round that follows a person’s own turn still leads with the goal', async () => {
  // The ordinary shape: the person asked for something, the session worked, the round ended, and the
  // goal kept going. The eligible flag is already set by their own message — so this is not about the
  // report happening at all, it is about what it says: a card that reads like a finished result is the
  // belief that had a reader type into a session that was still working.
  const scaffolded = await scaffold({ resultNotify: 'idle' }, { services: SERVICES })
  await bind(scaffolded.route)
  const emit = liveGoal(scaffolded, goalView({ round: 1 }))

  humanRun(emit)
  await sleep(1100)
  const first = cardTitled(RESULT_TITLE)
  assert.ok(first, 'the person’s own turn is reported')
  assert.doesNotMatch(textOf(first.handle), /目标/, 'and a turn they started is not about a goal')

  scaffolded.goals.set('s_1', goalView({ round: 2 }))
  machineRun(emit, 2)
  await sleep(1100)

  // The newest card, not the first one carrying the title: the round's report supersedes the answer
  // before it, and the superseded card is rewritten to say so.
  const shown = cardFrom(lastDelivered())
  assert.equal(shown.header.title.content, RESULT_TITLE, 'the round ends in a result of its own')
  const text = textOf(lastDelivered())
  assert.match(text, /目标进行中 · 第 2\/5 轮（自动继续）/, 'the round says where the goal stands')
  assert.match(text, new RegExp(OBJECTIVE), 'and which goal it is')
  assert.doesNotMatch(text, /开下一段/, 'and it does not offer the next task')
})

test('the round cap reaches a card that is already on the phone', async () => {
  const scaffolded = await goalDeployment()
  const emit = liveGoal(scaffolded, goalView({ round: 1 }))
  humanRun(emit)
  await settle()
  scaffolded.goals.set('s_1', goalView({ round: 5 }))
  machineRun(emit, 5)
  await settle()

  const shown = activityCard()
  const before = textOf(shown.handle)
  assert.match(before, /目标进行中 · 第 5\/5 轮（自动继续）/, 'the last round is drawn while it is admitted')

  // The driver blocks the goal at the cap instead of starting another round
  // (`dsh-goal-round-driver/lib/index.js:125-131`). No session event follows it.
  scaffolded.goals.set('s_1', goalView({ round: 5, phase: 'blocked' }))
  scaffolded.emitToAll('goal/changed', {
    agent: scaffolded.agents.get('s_1'),
    change: { operation: 'block', roundsStarted: 5 },
  })
  await settle()

  assert.match(textOf(shown.handle), /目标已达轮数上限，已暂停/, 'the cap is on the card')
  assert.doesNotMatch(textOf(shown.handle), /目标进行中/, 'and it no longer claims to be working')
})

test('a goal paused after an interrupted round reaches the card', async () => {
  const scaffolded = await goalDeployment()
  const emit = liveGoal(scaffolded, goalView({ round: 1 }))
  humanRun(emit)
  await settle()
  scaffolded.goals.set('s_1', goalView({ round: 2 }))
  machineRun(emit, 2)
  await settle()
  const shown = activityCard()

  // What the driver does when a round it queued or claimed was aborted: the goal is paused, and the
  // session log says nothing about it (`dsh-goal-round-driver/lib/index.js:213-236`).
  scaffolded.goals.set('s_1', goalView({ round: 2, phase: 'paused' }))
  scaffolded.emitToAll('goal/changed', {
    agent: scaffolded.agents.get('s_1'),
    change: { operation: 'pause', roundsStarted: 2 },
  })
  await settle()

  const text = textOf(shown.handle)
  assert.match(text, /目标已暂停（本轮被打断）/, 'the pause is on the card')
  assert.doesNotMatch(text, /自动继续/, 'and nothing promises it will continue')
})

test('a goal that completes reaches the card', async () => {
  const scaffolded = await goalDeployment()
  const emit = liveGoal(scaffolded, goalView({ round: 1 }))
  humanRun(emit)
  await settle()
  scaffolded.goals.set('s_1', goalView({ round: 2 }))
  machineRun(emit, 2)
  await settle()
  const shown = activityCard()

  // The model marks the goal complete from inside the round that proved the work done, and the round
  // itself ends normally: the only thing that says the goal is over is the domain's own change.
  scaffolded.goals.set('s_1', goalView({ round: 2, phase: 'complete' }))
  scaffolded.emitToAll('goal/changed', {
    agent: scaffolded.agents.get('s_1'),
    change: { operation: 'complete', roundsStarted: 2 },
  })
  await settle()

  assert.match(textOf(shown.handle), /目标已完成/, 'the end of the goal is on the card')
})

test('an active goal the host disarmed is not drawn as one that continues', async () => {
  const scaffolded = await goalDeployment()
  const emit = liveGoal(scaffolded, goalView({ round: 1 }))
  humanRun(emit)
  await settle()
  scaffolded.goals.set('s_1', goalView({ round: 2 }))
  machineRun(emit, 2)
  await settle()
  const shown = activityCard()

  // Disarming is process-local and does not change the durable phase: the goal is still the
  // session's, and nothing will continue it until a person resumes it. The host's own goal bar draws
  // that as its own state (`dsh-client-ui-goal/lib/client.js:167-170`), and a card that said
  // "自动继续" here would promise work that is not going to happen.
  scaffolded.goals.set('s_1', goalView({ round: 2, activation: 'disarmed' }))
  scaffolded.emitToAll('goal/activation-changed', { sessionId: 's_1' })
  await settle()

  const text = textOf(shown.handle)
  assert.match(text, /目标未运行 · 第 2\/5 轮/, 'the card says the goal is not running')
  assert.doesNotMatch(text, /自动继续/, 'and does not claim otherwise')
})

test('the state route carries the goal without waiting for an event', async () => {
  const scaffolded = await scaffold({}, { services: SERVICES })
  scaffolded.agents.set('s_1', { status: 'idle', followup: () => {} })
  // Set and never announced: this is a deployment that was just restarted, or a page that was just
  // opened, and the round happened before either — the case the map alone cannot answer.
  scaffolded.goals.set('s_1', goalView({ round: 4, objective: `${OBJECTIVE}\n第二行不该出现在卡片上` }))

  const state = await scaffolded.state()
  assert.equal(state.goal.available, true, 'the route says the goal panel is composed')
  assert.equal(state.goal.goals.length, 1, 'and reports the session that has a goal')
  const [goal] = state.goal.goals
  assert.equal(goal.session, 's_1')
  assert.equal(goal.phase, 'active')
  assert.equal(goal.round, 4)
  assert.equal(goal.maxRounds, 5)
  // One clipped line: an objective is a prompt a person wrote, and a card is not the place for it.
  assert.equal(goal.objective.includes('\n'), false, 'the objective is one line')
  assert.match(goal.objective, /…（内容过长已截断）|^把发布流程整理成文档 第二行不该出现在卡片上$/)
})

test('without the goal panel every card is what it was', async () => {
  // The ordinary deployment: `goals` is not part of the harness core, so a case has to ask for it and
  // this one does not. The same round arrives — the harness emits what the log holds — and nothing
  // may move: no activity card change, and no result card at all.
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  scaffolded.agents.set('s_1', { status: 'idle', followup: () => {} })
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)

  humanRun(emit)
  await settle()
  const before = activityCard()
  const delivered = observed.created.length

  machineRun(emit, 2)
  await sleep(1100)

  // The activity card has not moved at all, and it still says the run it drew is over: a round is not a
  // boundary this deployment's plugin can draw, because nothing told it what a round is.
  assert.equal(textOf(activityCard().handle), textOf(before.handle), 'the card has not moved')
  assert.match(textOf(before.handle), /已结束/, 'and still says the run is over')
  // Whatever the notifier did with the round — it does report a turn in a session where a person has
  // spoken — nothing on the phone names a goal or promises one will continue.
  assert.ok(observed.created.length >= delivered, 'the round is not a reason for a card of its own')
  for (const entry of observed.delivered) {
    assert.doesNotMatch(textOf(entry.handle), /目标/, `no card names a goal: ${textOf(entry.handle)}`)
  }
  const state = await scaffolded.state()
  assert.equal(state.goal.available, false, 'and the route says the goal panel is not composed')
  assert.deepEqual(state.goal.goals, [], 'with nothing to report')
})
