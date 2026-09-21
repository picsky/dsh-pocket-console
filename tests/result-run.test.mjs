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
import { CARD_BODY_BUDGET } from '../budget.js'
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
 *
 * The asking session records what is handed to it, so a case about a reply can check that the
 * instruction actually reached the session rather than only that the card was rewritten.
 * @param plan - the plan text the run opens with.
 * @param options - `refuseFirst` makes the first hand-off throw, which is the failure the reply
 *   path has to survive: the instruction is in the session or it is not, and everything else the
 *   path does is about a card.
 * @returns the scaffold result, the result card, the asked session's follow-ups, and how many
 *   hand-offs were attempted.
 */
async function afterARun(plan = PLAN, { refuseFirst = false } = {}) {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(scaffolded.route)
  /** What the reply handed to the asking session, in order. */
  const followed = []
  /** How many times the path tried to hand something over, including the failures. */
  const attempts = { count: 0 }
  scaffolded.agents.set('s_1', {
    status: 'idle',
    session: { header: { cwd: '/work/my-app' } },
    followup: (message) => {
      attempts.count += 1
      if (refuseFirst && attempts.count === 1) throw new Error('the session was reclaimed mid-press')
      followed.push(message)
    },
  })
  await phoneHoldsIt(scaffolded)
  observed.created.length = 0
  runWithAPlan(scaffolded, 's_1', plan)
  await sleep(1_400)
  return { scaffolded, result: cardTitled('DSH 结果'), followed, attempts }
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

  assert.match(folded, /思考过程/, 'the fold is labelled as the run')
  assert.match(folded, /## 方案/, 'the plan is what a reader opens it for')
  assert.match(folded, /第1步/, 'including where the run set out from')
})

test('a long run is shown whole, not trimmed to fit', async () => {
  const { result } = await afterARun()
  const folded = foldedRun(result.card)

  // The point of the budget being measured rather than copied: a run of this length **fits**, and a
  // reader deciding what to do next gets all of it. Trimming here was the old behaviour, and it is
  // what made "we keep history so you can read it" self-defeating.
  assert.match(folded, /## 方案/, 'the plan is there')
  assert.match(folded, /第1步/, 'from where the run set out')
  assert.match(folded, /第60步/, 'through every step it planned')
  assert.match(folded, /测试也过了/, 'to where it stopped')
  // Nothing was given up, so nothing may claim to have been.
  assert.equal(/省略/.test(folded), false, 'and nothing is claimed to be missing')
})

test('a run past the budget gives up whole kinds of content before it drops text', async () => {
  // Past 32 KB of text, so no level can show all of it: the layering has to start giving things up.
  const huge = ['## 方案', ...Array.from({ length: 400 }, (_, i) => `${i + 1}. 第${i + 1}步：把模块改好并补上测试。`)].join('\n')
  const { result } = await afterARun(huge)
  const folded = foldedRun(result.card)

  // The newest prose is what a reader is deciding on, so it survives; what goes is older material.
  assert.match(folded, /测试也过了/, 'the end of the run survives')
  assert.match(folded, /省略/, 'and what was given up is named rather than implied')
  // The fold is one element per group plus the marker, nowhere near the platform's 200-element
  // ceiling: a hundred-step run would reach it with one element per tool line.
  const panel = result.card.body.elements.find(element => element.tag === 'collapsible_panel')
  assert.ok(panel.elements.length <= 121, `the fold stays inside the element budget: ${panel.elements.length}`)
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
  // The fold competes with the card face for one message. The platform's real body limit was
  // measured against this tenant at 131 KB accepted and 164 KB refused (the documented 30 KB is
  // wrong — see `internal/boundaries.md`), and every card this deployment actually sends has to sit
  // under the budget the renderer enforces for it.
  //
  // Asserted against the whole **request**, which is what the platform weighs, on every write the
  // run produced rather than on the result card alone: the per-part budgets bound a string and an
  // element count, and neither of them bounds the body — that is what `CARD_BODY_BUDGET` is for, and
  // this is the case that says the renderer applies it to real traffic.
  const writes = [...observed.created, ...observed.patched]
  assert.ok(writes.length > 0, 'the card was written')
  for (const write of writes) {
    const body = Buffer.byteLength(JSON.stringify({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_x', msg_type: 'interactive', content: write.data.content },
    }), 'utf8')
    assert.ok(
      body <= CARD_BODY_BUDGET,
      `every body stays inside the renderer's own whole-card budget: ${body} bytes`,
    )
    assert.ok(body < 131 * 1024, `and well inside the measured platform cap: ${body} bytes`)
  }
})

test('the reply turns the card it was answered on into the run’s own card', async () => {
  const { result, followed } = await afterARun()
  const reply = callbackValues(result.card).find(value => value.submit === true)
  assert.ok(reply, 'the card came with a box to reply in')
  const field = reply.submits?.value
  assert.ok(typeof field === 'string', 'the reply control names itself: ' + JSON.stringify(reply.submits))
  const sentBefore = observed.delivered.length

  await clickCard(reply, { [field]: '接着做下一步' }, { messageId: result.handle })
  // The run's card is written on the refresh window rather than inside the press — the toast is
  // answered first so the callback stays inside the platform's three-second budget — and waiting for
  // the write, not for a fixed tick, is what keeps this case from passing or failing on how fast the
  // machine is.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (String(cardFrom(result.handle)?.header?.title?.content ?? '').startsWith('DSH 执行中')) break
    await sleep(25)
  }

  // The whole of the rule: the card that moves is the card the person touched. A reply used to leave
  // "已收到指令" here and show the run on a **second** message, so the reader gave an instruction and
  // watched the card in their hand stay still while the run went on somewhere else.
  const after = cardFrom(result.handle)
  assert.equal(
    after.header.title.content,
    'DSH 执行中 · my-app',
    'the card the reply came from became the run’s card, workspace and all',
  )
  assert.equal(observed.delivered.length, sentBefore, 'and no second message was sent for that run')
  assert.deepEqual(
    callbackValues(after).some(value => value.submit === true),
    false,
    'the box it was answered through is gone, so one answer cannot be sent twice',
  )
  // The face is the live run, not a sentence about the reply. Copy that points at a control which is
  // no longer there is the same lie as dropping the answer, only quieter — the reply hint and the
  // whole next-task block went with the box they belonged to.
  const words = after.body.elements.map(element => element.content ?? '').join('\n')
  assert.match(words, /处理中/, 'the face says the run is going')
  assert.equal(/已收到指令/.test(words), false, 'and not that the instruction arrived')
  assert.equal(/回复这条消息/.test(words), false, 'and nothing points at the reply box that is gone')
  assert.equal(/开下一段|新会话里开/.test(words), false, 'nor at the next-task form that is gone')
  assert.equal(followed.at(-1).content[0].text, '接着做下一步', 'while the instruction itself reached the session')
})

test('the result of the run a reply started is a card of its own', async () => {
  const { result, scaffolded } = await afterARun()
  const reply = callbackValues(result.card).find(value => value.submit === true)
  const field = reply.submits.value
  await clickCard(reply, { [field]: '接着做下一步' }, { messageId: result.handle })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (String(cardFrom(result.handle)?.header?.title?.content ?? '').startsWith('DSH 执行中')) break
    await sleep(25)
  }
  const afterReply = observed.delivered.length

  // The second half of the rule, and the half that is easy to get wrong by being clever: the run that
  // reply started reports itself on a card of its own, rather than folding its result back into the
  // card the person is watching. "执行中" and "结果" are two different cards, and confusing them is
  // what leaves an answer welded to the progress that replaced it.
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
  // The reply itself: the stub records the hand-off rather than replaying it as a session event, so
  // the run that instruction starts is opened here the way the harness would open it.
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '接着做下一步' }] },
  })
  emit({ type: 'turn/start', data: { turn: 2 } })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二步也做完了。' }] } },
  })
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await sleep(1_400)

  const again = cardTitled('DSH 结果')
  assert.ok(again, 'the run’s result came to the phone')
  assert.notEqual(again.handle, result.handle, 'as a card of its own, not the card the reply was made on')
  assert.equal(observed.delivered.length, afterReply + 1, 'and it cost exactly one message')
  const face = again.card.body.elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n')
  assert.match(face, /第二步也做完了/, 'carrying what that run ended with')
  // What the reader answered is still on a card: the one they replied on now shows the run it started,
  // and that run's own record — including the turn before it — is what its fold holds.
  assert.match(foldedRun(again.card) ?? '', /接着做下一步/, 'and the instruction it was answering')
})

test('a second press on the card the reply came from does not overwrite the run', async () => {
  const { result, followed } = await afterARun()
  const reply = callbackValues(result.card).find(value => value.submit === true)
  const field = reply.submits.value
  await clickCard(reply, { [field]: '接着做下一步' }, { messageId: result.handle })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (String(cardFrom(result.handle)?.header?.title?.content ?? '').startsWith('DSH 执行中')) break
    await sleep(25)
  }

  // The same press again, from the same card. Its rid died with the first answer, so this lands in the
  // branch that tells a reader the card they are holding no longer takes replies — and that branch
  // used to rewrite whatever message the press came from. The message it comes from is now the card
  // the run is being shown in, so "此卡已失效" over it would replace the one thing on the phone that is
  // still true with a sentence about a notice that is gone.
  const again = await clickCard(reply, { [field]: '接着说' }, { messageId: result.handle })
  assert.equal(again.toast.content, '该结果已过期', 'the press is refused, and said so')
  await sleep(50)
  const titles = observed.patched
    .filter(entry => entry.path?.message_id === result.handle)
    .map((entry) => {
      try { return JSON.parse(entry.data.content).header.title.content } catch { return '' }
    })
  assert.equal(
    titles.some(title => String(title).startsWith('DSH 结果')),
    false,
    'and the run’s card was not renamed back into a stale notice',
  )
  assert.equal(
    cardFrom(result.handle).header.title.content,
    'DSH 执行中 · my-app',
    'the card still shows the run',
  )
  assert.equal(followed.length, 1, 'and the second press sent nothing to the session')
})

test('a reply that never reached the session is not reported as sent', async () => {
  // The failure this case exists for: the earlier version fired the hand-off and answered
  // "已发送给 agent" immediately. A reply that never arrived was reported as sent, so the reader
  // stopped thinking about it — while the rid was dead in memory *and* on disk and the card had
  // already been rewritten to say the instruction had arrived. Being told a lie about the one
  // thing this plugin does is worse than being told it failed.
  const { result, followed, attempts } = await afterARun(PLAN, { refuseFirst: true })
  const reply = callbackValues(result.card).find(value => value.submit === true)
  const field = reply.submits.value

  const toast = await clickCard(reply, { [field]: '接着做下一步' }, { messageId: result.handle })
  assert.equal(attempts.count, 1, 'the hand-off was attempted')
  assert.equal(followed.length, 0, 'and it did not land')
  // The channel maps the handler's `accepted` onto the toast's type, so a warning is what a
  // refusal looks like from the reader's side.
  assert.equal(toast.toast.type, 'warning', 'so the press is refused, not toasted as success')
  assert.match(
    String(toast.toast.content),
    /没能送出去/,
    'and the reader is told it did not go: ' + JSON.stringify(toast.toast),
  )

  // The box has to still be there, because the notice was put back: a reply that failed must
  // remain sendable, or the person has to reconstruct it from memory.
  const afterFailure = cardFrom(result.handle)
  const stillAnswerable = callbackValues(afterFailure).some(value => value.submit === true)
  assert.equal(stillAnswerable, true, 'the reply box is still on the card')
  assert.equal(
    /已收到指令/.test(JSON.stringify(afterFailure)),
    false,
    'and the card does not claim the instruction arrived',
  )

  // And a second press goes through, which is the whole reason the notice came back.
  const retry = await clickCard(reply, { [field]: '接着做下一步' }, { messageId: result.handle })
  assert.equal(retry.toast.type, 'success', 'the retry is accepted')
  assert.equal(followed.length, 1, 'and this time the instruction landed')
  assert.equal(followed[0].content[0].text, '接着做下一步')
})
