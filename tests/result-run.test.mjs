/**
 * The result card carries the run, not only the last thing said.
 *
 * A turn that ends with a couple of confirmations ends on a confirmation, and the plan being
 * confirmed is then nowhere on the phone — which is the whole reason this exists. What a reader has
 * to be able to see is **what the run set out to do** and **where it stopped**, so the cases below
 * are written against those two ends rather than against the shape of the card.
 *
 * The constraint that makes this acceptable is that it costs no message: the run goes into a fold on
 * a card that was already being sent.
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

/** The folded run a card carries, or undefined when it has none. */
function foldedRun(card) {
  const panel = (card?.body?.elements ?? []).find(element => element.tag === 'collapsible_panel')
  if (panel === undefined) return undefined
  return [
    panel.header?.title?.content,
    ...(panel.elements ?? []).map(element => element.content),
  ].filter(part => part !== undefined).join('\n')
}

/**
 * Put the phone in charge, so a result notice is offered at all.
 * @param scaffolded - the scaffold result.
 */
async function phoneHoldsIt(scaffolded) {
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  for (let attempt = 0; attempt < 60 && observed.created.length < 1; attempt += 1) await sleep(50)
  await clickCard(callbackValues(cardFrom(lastDelivered())).find(value => value.v === 'allowed-once'))
}

/** A plan long enough that neither the last message nor one budget could hold all of it. */
const PLAN = ['## 方案', ...Array.from({ length: 60 }, (_, i) => `${i + 1}. 第${i + 1}步：把模块改好并补上测试。`)].join('\n')

/**
 * Drive one run: a person asks, the agent states a plan, then confirms a few times and stops.
 *
 * Fed through `emitToAll`, not through one listener: several machines follow the session feed and
 * Cordis dispatches to every one of them. A case that reached only the first would let the others
 * miss an event the deployment always delivers — which is exactly how the record this case is about
 * came back empty.
 * @param scaffolded - the scaffold result.
 * @param id - session id.
 * @param plan - the plan text the run opens with.
 */
function runWithAPlan(scaffolded, id, plan = PLAN) {
  const emit = (event) => scaffolded.emitToAll('session/event', { id }, event)
  emit({ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把剩下的两个 shard 做完' }] } })
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: plan }] } } })
  for (const text of ['好了。', '已经改完。', '测试也过了。']) {
    emit({ type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
  }
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/**
 * A deployment where the phone holds the person and one run with a plan has just stopped.
 * @param plan - the plan text the run opens with.
 * @returns the scaffold result, the emitter, and the result card.
 */
async function afterARun(plan = PLAN) {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(scaffolded.route)
  scaffolded.agents.set('s_1', {
    status: 'idle',
    session: { header: { cwd: '/work/my-app' } },
    followup: () => {},
  })
  await phoneHoldsIt(scaffolded)
  observed.created.length = 0
  runWithAPlan(scaffolded, 's_1', plan)
  await sleep(1_400)
  return { scaffolded, result: cardTitled('DSH 结果') }
}

test('the result card carries the plan the run opened with', async () => {
  const { result } = await afterARun()
  assert.ok(result, 'the result went to the phone')
  const folded = foldedRun(result.card)
  assert.ok(folded !== undefined, 'and it carries the run')

  // The last message alone was the whole problem: it says the tests passed and not what was done.
  const face = result.card.body.elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n')
  assert.match(face, /测试也过了/, 'the card face still shows the answer')
  assert.equal(face.includes('## 方案'), false, 'and the plan is not on the face — the face is for glancing at')

  assert.match(folded, /这一段做了什么/, 'the fold is labelled as the run')
  assert.match(folded, /## 方案/, 'the plan is what a reader opens it for')
  assert.match(folded, /第1步/, 'including where the run set out from')
})

test('a run too long to show keeps both ends and says what it left out', async () => {
  const { result } = await afterARun()
  const folded = foldedRun(result.card)

  // Both ends, because those are the two things a decision needs: what it set out to do, and where
  // it stopped. A prefix would keep the plan and lose the ending; a suffix the reverse.
  assert.match(folded, /## 方案/, 'the beginning survives')
  assert.match(folded, /测试也过了/, 'and so does the end')
  // Named rather than implied: a reader who is not told cannot tell a short run from a truncated one.
  assert.match(folded, /省略/, 'and the omission is stated')
})

test('a short run is shown whole, with nothing claimed to be missing', async () => {
  const { result } = await afterARun('## 小方案\n1. 改一个地方。')
  const folded = foldedRun(result.card)
  assert.match(folded, /小方案/, 'the run is there')
  assert.equal(/省略/.test(folded), false, 'and nothing is claimed to be missing')
})

test('carrying the run costs no extra message', async () => {
  const { scaffolded } = await afterARun()
  // The promise that makes this acceptable: the run rides a card that was already being sent. A
  // second message for it would be one notification per run more than the phone agreed to.
  const resultCards = observed.created.filter((request) => {
    try { return JSON.parse(request.data.content).header.title.content.startsWith('DSH 结果') } catch { return false }
  })
  assert.equal(resultCards.length, 1, 'one result message, and only one')
  assert.equal(scaffolded.sessionController.created.length, 0, 'and no session was started by any of it')
})

test('the card carrying the run still fits the platform', async () => {
  await afterARun()
  // The fold competes with the card face for one message, and the platform refuses a body over
  // 30 KB — measured the way the request will carry it, since the card JSON is escaped again on its
  // way out. A card that says everything and arrives as nothing is worse than a shorter one.
  const bodies = [
    ...observed.created.map(request => request.data.content),
    ...observed.patched.map(request => request.data.content),
  ]
  assert.ok(bodies.length > 0, 'the card was written')
  for (const content of bodies) {
    const body = Buffer.byteLength(JSON.stringify(content), 'utf8')
    assert.ok(body < 30 * 1024, `the body stays inside the platform cap: ${body} bytes`)
  }
})
