/**
 * The activity card: what a run is doing, while it is doing it.
 *
 * How these cases read the card, and why:
 *
 * - Through `cardTitled` / `cardFrom`, which locate a card by the handle the platform returned.
 *   Reading "the newest patch anywhere" would let a body assertion pass against a different
 *   card — the escalation a case uses to take the phone over is a card too.
 * - After `settle()`, longer than the refresh window: the card is edited on a trailing window,
 *   so reading immediately would read the version from before the event.
 * - Never through `sentCard()`, which asserts that exactly one card was delivered. These cases
 *   cause more than one on purpose.
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
  lastDelivered,
  cardFrom,
  cardTitled,
} from './support/harness.mjs'

/** Wait past one refresh window, so the card reflects everything emitted before it. */
const settle = () => sleep(400)

/** The title every activity card starts with, which no other card does. */
const ACTIVITY_TITLE = 'DSH 执行中'

/**
 * What the platform refused, measured on the real tenant rather than read from its documentation.
 *
 * The documentation says 30 KB. A 131 KB body was **accepted** and a 164 KB one was refused with
 * `230025`; `patch` accepted 98 KB. These cases assert against the measured refusal with room under
 * it, because a limit copied from a document is what made every long history truncate: the budget was
 * built to a third of a ceiling the platform does not have.
 */
const PLATFORM_BODY_CEILING = 150 * 1024

/**
 * What one delivered card costs in the request body, which is the number the platform caps.
 *
 * Not a guess and not the text's own size: the card JSON is the request's `content` parameter, so
 * it is escaped once more on the way out, and a case that measured anything less would pass while
 * the platform refused the card. This is what the deployment actually puts on the wire.
 * @param content - the card JSON as the channel sent it.
 * @returns its size in the request body.
 */
const bodySize = (content) => Buffer.byteLength(JSON.stringify(content), 'utf8')

/**
 * Every card body this case has delivered, so a case can assert the cap over all of them.
 * @returns the delivered card JSON strings.
 */
const deliveredBodies = () => [
  ...observed.created.map(request => request.data.content),
  ...observed.patched.map(request => request.data.content),
]

/**
 * The folded record a card carries, as one string, or undefined when it has none.
 *
 * Read from the rendered card rather than the view: a view's `details` becomes the platform's own
 * foldable element, and what a reader sees is what that element holds — its label first, then the
 * text. The element's other markup is left out, so a case can measure the text against the card's
 * own budget without counting the fixed cost the budget deliberately leaves room for.
 * @param card - the rendered card JSON.
 * @returns the label and text the fold holds, or undefined when the card does not fold.
 */
function foldedRecord(card) {
  const panel = (card?.body?.elements ?? []).find(element => element.tag === 'collapsible_panel')
  if (panel === undefined) return undefined
  return [
    panel.header?.title?.content,
    ...(panel.elements ?? []).map(element => element.content),
  ].filter(part => part !== undefined).join('\n')
}

/**
 * The activity card this deployment has sent, with the handle it lives in.
 * @returns the handle and current card, or undefined when none has been sent.
 */
const activityCard = () => cardTitled(ACTIVITY_TITLE)

/**
 * Emit one text delta on the live stream, the way the model produces them.
 *
 * Through `emitFrame`, which delivers the single `{ agent, frame }` payload Cordis delivers.
 * The event name is not spelled out here on purpose: a case that assembled its own two-argument
 * emission would certify a call shape the deployment never produces — which is how the live
 * stream once shipped reading a second argument that never arrived.
 * @param scaffolded - the scaffold result.
 * @param session - session id.
 * @param text - the delta.
 */
function delta(scaffolded, session, text) {
  scaffolded.emitFrame(session, { type: 'chunk', chunk: { type: 'text-delta', text } })
}

/**
 * Open a step on the live stream, the way the loop does before its first chunk.
 *
 * The `start` frame is the only one that carries the step number, so a case that streams deltas
 * without it is a case where the card cannot tell which step its text belongs to.
 * @param scaffolded - the scaffold result.
 * @param session - session id.
 * @param step - the step number.
 */
function startStep(scaffolded, session, step) {
  scaffolded.emitFrame(session, { type: 'start', turn: 2, step })
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
  // The last card, not "the only card": a case may have caused others before this one, and
  // `sentCard()` insists on exactly one delivery, which is not a property these cases have.
  const card = cardFrom(lastDelivered())
  await clickCard(callbackValues(card).find(value => value.v === 'allowed-once'))
}

/**
 * A deployment where the phone holds the person.
 * @returns the scaffold result.
 */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  return scaffolded
}

/**
 * Start a run and return the activity card it caused.
 * @param scaffolded - a scaffold where the phone holds the person.
 * @param session - session id.
 * @returns the handle and card of the activity card.
 */
async function startRun(scaffolded, session) {
  scaffolded.emitToAll('session/event', { id: session }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  const shown = activityCard()
  assert.ok(shown, 'the run is shown')
  return shown
}

test('no activity card is sent while the desk holds the person', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)

  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  delta(scaffolded, 's_1', '正在检查。')
  await settle()

  // The desk is where this run is visible, so a card on the phone would be a message nobody
  // asked for — which is the one thing this plugin says it does not send.
  assert.equal(activityCard(), undefined, 'the desk having the person means no activity card')
})

test('a run under phone priority gets one card, and its text grows', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle, card } = await startRun(scaffolded, 's_1')
  assert.equal(card.header.template, 'blue', 'a run in progress is the calm colour')

  delta(scaffolded, 's_1', '先看一下')
  await settle()
  assert.match(JSON.stringify(cardFrom(handle)), /先看一下/, 'and carries the text')

  const before = lastDelivered()
  delta(scaffolded, 's_1', '测试失败的那两个用例')
  await settle()
  // The card is a message that is rewritten, never a new message: sending again would notify,
  // and a card that announces itself on every paragraph is the noise this design avoids.
  assert.equal(lastDelivered(), before, 'and it is never re-sent')
  assert.match(JSON.stringify(cardFrom(handle)), /先看一下测试失败的那两个用例/, 'the text grew in place')
})

test('a burst of deltas becomes one edit, not one edit per delta', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')
  observed.patched.length = 0

  // Sixty deltas in one burst, which is what a model writing a paragraph produces. Feishu
  // allows five edits a second to one message, so this has to collapse rather than be refused.
  for (let index = 0; index < 60; index += 1) delta(scaffolded, 's_1', `第${index}段 `)
  await settle()

  const edits = observed.patched.filter(entry => entry.path?.message_id === handle).length
  assert.equal(edits, 1, `sixty deltas in one window are one edit: ${edits}`)
  assert.match(JSON.stringify(cardFrom(handle)), /第59段/, 'and the card carries the newest of them')
})

test('the card keeps the newest fragments and nothing else', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  for (const piece of ['一', '二', '三', '四', '五']) {
    delta(scaffolded, 's_1', piece)
    await settle()
  }

  const content = JSON.stringify(cardFrom(handle))
  // The card shows the tail of the stream — what the model is writing now — not the whole
  // answer, which is what the result notice is for.
  assert.match(content, /三四五/, 'the newest three are what the card carries')
  assert.equal(content.includes('一'), false, 'and the older ones have been dropped')
})

test('a card carries nothing to press', async () => {
  const scaffolded = await phoneHoldsIt()
  const { card } = await startRun(scaffolded, 's_1')

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

  const { card } = await startRun(scaffolded, 's_ws')
  assert.equal(card.header.title.content, 'DSH 执行中 · my-app', 'the title names the workspace')
})

test('the card says what the run is doing, and freezes when the turn ends', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')
  delta(scaffolded, 's_1', '先看一下')
  await settle()
  assert.match(JSON.stringify(cardFrom(handle)), /处理中/, 'a running step says so')
  assert.equal(JSON.stringify(cardFrom(handle)).includes('undefined'), false, 'and nothing reads as undefined')
  assert.equal(foldedRecord(cardFrom(handle)), undefined, 'a live card folds nothing')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, callId: 'c1', name: 'npm test' },
  })
  await settle()
  assert.match(JSON.stringify(cardFrom(handle)), /npm test/, 'a tool call is named')
  assert.match(JSON.stringify(cardFrom(handle)), /等待工具/, 'and the status says what it waits on')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()
  const frozen = cardFrom(handle)
  assert.match(JSON.stringify(frozen), /已结束/, 'a finished turn stops claiming to run')
  assert.equal(JSON.stringify(frozen).includes('npm test'), false, 'and stops naming the tool')
  // Frozen is what tells a record from a live card when the reader scrolls back.
  assert.equal(frozen.header.template, 'grey', 'and the card is muted')
  assert.ok(foldedRecord(frozen), 'and it folds the record of what the run did')
  assert.match(foldedRecord(frozen), /本次执行过程/, 'under a label that says what it is')
  assert.deepEqual(callbackValues(frozen), [], 'with nothing left to press')
})

test('the folded record holds what the run said, and what failed', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把测试修好' }] },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, message: { content: [{ type: 'text', text: '我先看失败的用例。' }] } },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, callId: 'c1', name: 'pwsh' },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/result',
    surfaceOp: 'append',
    // The shape the session actually records: `error` carries a kind and a code, the prose is the
    // result's own content blocks, and the block names only the call id — so the tool's name can
    // only come from the `tool/call` before it. A fixture with `error.message` and a string
    // `content` would certify a shape that never reaches this code, which is exactly how a line
    // that renders `[object Object]` instead of the reason stays unnoticed.
    data: {
      turn: 2,
      step: 1,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          isError: true,
          content: [{ type: 'text', text: 'Command failed with exit code 1' }],
        }],
      },
      error: { name: 'ToolExecutionError', code: 'EXIT_1' },
    },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 2,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'c2',
          content: [{ type: 'text', text: 'ok' }],
        }],
      },
    },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const record = foldedRecord(cardFrom(handle))
  assert.match(record, /把测试修好/, 'what the person asked for is in it')
  assert.match(record, /我先看失败的用例/, 'and what the run said')
  assert.match(record, /工具失败/, 'a failed tool earns a line')
  assert.match(record, /pwsh/, 'naming the tool that failed')
  assert.match(record, /exit code 1/, 'with the reason a reader can act on')
  assert.equal(record.includes('c2'), false, 'and a tool that worked is not in it')
})

test('a long run folds a bounded record, keeping its end', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  // Two hundred messages, each long enough that the whole of them could not fit in one card. A
  // card the platform refuses says nothing at all, so the record has to be bounded — and what a
  // reader wants from a finished run is how it ended, not how it began.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, message: { content: [{ type: 'text', text: `开头标记 ${'x'.repeat(200)}` }] } },
  })
  for (let index = 0; index < 200; index += 1) {
    scaffolded.emitToAll('session/event', { id: 's_1' }, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { turn: 2, message: { content: [{ type: 'text', text: `第${index}段 ${'x'.repeat(200)}` }] } },
    })
  }
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, message: { content: [{ type: 'text', text: `结尾标记 ${'y'.repeat(200)}` }] } },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const record = foldedRecord(cardFrom(handle))
  assert.ok(record, 'the record is there')
  // The bound is the point: two hundred messages would be a document inside one message, and a
  // card the platform refuses says nothing at all. The record is bounded as it is built, which is
  // what keeps its fold inside the card the platform will accept.
  assert.ok(
    record.length < 20_000,
    `the fold is bounded, not the whole run: ${record.length} characters`,
  )
  for (const body of deliveredBodies()) {
    assert.ok(bodySize(body) < PLATFORM_BODY_CEILING, `the card stays inside the cap: ${bodySize(body)} bytes`)
  }
  assert.match(record, /结尾标记/, 'and it holds the end of the run')
})

test('a step whose text both streamed and settled is folded once', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  // The ordinary shape of a run: the text arrives live, and then the same text commits as the
  // step's message. Folding both would put every word on the card twice.
  startStep(scaffolded, 's_1', 1)
  delta(scaffolded, 's_1', '这一句话会从两条路过来。')
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '这一句话会从两条路过来。' }] },
    },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const record = foldedRecord(cardFrom(handle))
  const appearances = record.split('这一句话会从两条路过来。').length - 1
  assert.equal(appearances, 1, `the text is in the record once, not twice: ${appearances}`)
})

test('a step that only streamed is still folded', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  // The other half of the same rule: text that arrived only as live frames has no committed
  // message to have folded it, so the end of the turn is the last chance to keep it.
  startStep(scaffolded, 's_1', 1)
  delta(scaffolded, 's_1', '只有实时片段的一段话。')
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  assert.match(foldedRecord(cardFrom(handle)), /只有实时片段的一段话/, 'the frames reached the record')
})

test('a settled card with nothing to show folds nothing', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  // A turn can end without ever saying anything: cancelled before the first token, or failed
  // outright. An empty fold would offer the reader a panel that opens onto nothing.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const card = cardFrom(handle)
  assert.equal(foldedRecord(card), undefined, 'there is no fold to open')
  assert.match(JSON.stringify(card), /已结束/, 'but the card still says the run is over')
})

test('a settled card is not rewritten by the turn it already closed', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()
  const frozen = JSON.stringify(cardFrom(handle))

  // A late event from the turn that just ended. The log is append-ordered, so this is the
  // boundary arriving twice rather than a reordering — and folding it would put text into a
  // record that claims to be the finished run.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '迟到的内容' }] } },
  })
  await settle()

  assert.equal(JSON.stringify(cardFrom(handle)), frozen, 'the frozen card is left alone')
})

test('an event from a turn the card has left does not reach the new turn', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二轮说的话' }] } },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  // A third turn opens, and then an event arrives that belongs to the second. Folding it would
  // present an older run's text as something the new run just said.
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 3 } })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '属于旧轮次的内容' }] } },
  })
  await settle()

  const card = JSON.stringify(cardFrom(handle))
  assert.match(card, /第 3 轮/, 'the card is showing the new turn')
  assert.equal(card.includes('属于旧轮次的内容'), false, 'and none of the old turn leaked into it')
})

test('the record is bounded while a run goes, not only when it ends', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  // A long run must not accumulate its whole transcript in memory: the record is bounded as it is
  // built, which is what keeps a hundred-step run costing the same as a one-step run. The first
  // entry is the one to watch — if the bound is not applied as the record grows, it is still
  // there at the end.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: `最早的一句话 ${'x'.repeat(300)}` }] },
    },
  })
  // Enough to be over the record's bound several times over: 60 messages of 300 characters is
  // about four times the budget, so the earliest are the ones that have to go.
  for (let index = 0; index < 60; index += 1) {
    scaffolded.emitToAll('session/event', { id: 's_1' }, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: `第${index}段 ${'x'.repeat(300)}` }] },
      },
    })
  }
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const record = foldedRecord(cardFrom(handle))
  assert.equal(record.includes('最早的一句话'), false, 'the oldest entries were dropped as it grew')
  assert.match(record, /第59段/, 'and the newest are what is left')
})

test('the card body stays inside the platform cap when the text is escape-dense', async () => {
  const scaffolded = await phoneHoldsIt()
  await startRun(scaffolded, 's_1')

  // Thirty kilobytes caps the request body, and the body is not the text: the text is escaped into
  // the card JSON and the card JSON is escaped again as the request's `content`. Text made of
  // quotes and backslashes — tool output, JSON, code, which is much of what a run says — doubles at
  // each layer, so a budget counted in the text's own bytes produces a body over the cap. This is
  // the case the budget has to hold for, and it is the one that was measured above the cap.
  observed.created.length = 0
  observed.patched.length = 0
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '\\"'.repeat(60_000) }] },
    },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const written = deliveredBodies()
  assert.ok(written.length > 0, 'the card was written')
  for (const content of written) {
    // The one number that matters: what the request body costs once the card JSON is the value of
    // a form parameter, which is exactly how the deployment sends it.
    assert.ok(
      bodySize(content) < PLATFORM_BODY_CEILING,
      `the body stays inside the platform cap: ${bodySize(content)} bytes`,
    )
  }
})

test('the card body stays inside the platform cap when the text is Chinese', async () => {
  const scaffolded = await phoneHoldsIt()
  await startRun(scaffolded, 's_1')

  // The other shape of text that costs more than one byte per character. It is the easier of the
  // two, but a budget that holds only for one of them does not hold.
  observed.created.length = 0
  observed.patched.length = 0
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '中'.repeat(60_000) }] },
    },
  })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const written = deliveredBodies()
  assert.ok(written.length > 0, 'the card was written')
  for (const content of written) {
    assert.ok(
      bodySize(content) < PLATFORM_BODY_CEILING,
      `the body stays inside the platform cap: ${bodySize(content)} bytes`,
    )
  }
})

test('a card the platform refuses for size is retried smaller', async () => {
  const scaffolded = await phoneHoldsIt()

  // The budget keeps cards well inside the documented limit, but the real ceiling is documented
  // outside this repository. Without a retry the send would repeat the same view forever and the
  // reader would get no card at all.
  observed.failNextDelivery = 'invalid request: card content is too large'
  await startRun(scaffolded, 's_1')

  assert.equal(observed.deliveryFailures, 1, 'the first attempt was refused')
  const sent = observed.created.at(-1)
  assert.ok(sent, 'and the retry arrived')
  assert.ok(
    Buffer.byteLength(sent.data.content, 'utf8') < PLATFORM_BODY_CEILING,
    'as a smaller card',
  )
  assert.equal(
    scaffolded.debugs.some(line => line.includes('体积上限')),
    true,
    'and the retry is said out loud in the log, so a refused card is not silent',
  )
})

test('an edit the platform refuses for size is retried smaller', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  // A refusal on an edit used to be logged and dropped, which left the card showing an old state
  // for good — the reader's only view of the run, frozen on something that is no longer true.
  observed.failNextPatch = 'invalid request: card content is too large'
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '中'.repeat(60_000) }] },
    },
  })
  await settle()

  const edits = observed.patched.filter(entry => entry.path?.message_id === handle)
  assert.equal(observed.patchFailures, 1, 'the first edit was refused')
  assert.ok(edits.length >= 1, `the retry reached the same message: ${edits.length} edits`)
  for (const edit of edits) {
    assert.ok(
      Buffer.byteLength(edit.data.content, 'utf8') < PLATFORM_BODY_CEILING,
      `every edit stays inside the platform cap: ${Buffer.byteLength(edit.data.content, 'utf8')}`,
    )
  }
})

test('a step that streams more than the record can hold keeps its end', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')
  startStep(scaffolded, 's_1', 1)

  // A step's deltas are not bounded by anything: a model writing a long answer produces thousands
  // of them. Holding all of them would mean the card keeps an entire answer in memory, and the
  // fold would then be clipped from the wrong end.
  for (let index = 0; index < 100; index += 1) {
    delta(scaffolded, 's_1', `第${index}段${'中'.repeat(100)}`)
  }
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  const record = foldedRecord(cardFrom(handle))
  // The stream is kept bounded as the deltas arrive, so the fold is the end of the step rather
  // than the whole of it — and the end is what a reader opens the fold to find.
  assert.match(record, /第9\d段/, 'the end of the stream is what it keeps')
  assert.equal(record.includes('第0段'), false, 'with the beginning dropped first')
  for (const body of deliveredBodies()) {
    assert.ok(bodySize(body) < PLATFORM_BODY_CEILING, `the card stays inside the cap: ${bodySize(body)} bytes`)
  }
})

test('a session keeps one card across its turns, edited rather than re-sent', async () => {
  const scaffolded = await phoneHoldsIt()
  const first = await startRun(scaffolded, 's_1')
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  await settle()

  // The next turn is the same card, rewritten. A session that sent a card per turn would notify
  // the reader once per turn, which is the noise this whole design is built to avoid.
  const messages = observed.created.length
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 3 } })
  await settle()

  assert.equal(observed.created.length, messages, 'no new message was sent')
  assert.match(JSON.stringify(cardFrom(first.handle)), /第 3 轮/, 'the same card shows the new turn')
  assert.equal(foldedRecord(cardFrom(first.handle)), undefined, 'and a live card folds nothing again')
})

test('a turn that ends while its first send is in flight still gets rendered', async () => {
  const scaffolded = await phoneHoldsIt()

  // The end lands while the create is still being awaited — a network round trip, which is the
  // ordinary case. Whatever changed in the meantime has to reach the card: dropping it leaves a
  // card that says "Working" for good, and hides a failure entirely.
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'error', error: { message: '模型连接中断' } } },
  })
  await settle()
  await settle()

  const content = JSON.stringify(activityCard()?.card)
  assert.match(content, /出错/, 'the failure reaches a card that was still being sent')
  assert.match(content, /模型连接中断/, 'with its reason')
  assert.equal(content.includes('处理中'), false, 'and it does not keep claiming to work')
})

test('a disposed card is never written again, and a pending edit never fires', async () => {
  const scaffolded = await phoneHoldsIt()
  await startRun(scaffolded, 's_1')

  // Disposal is what a reload, an unload, or the next case's scaffold does.
  for (const dispose of scaffolded.disposers) dispose()
  const before = observed.created.length + observed.patched.length

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, name: 'npm test' },
  })
  // Longer than the refresh window and the clock tick both: a timer that survived disposal would
  // have fired by now. A leaked edit is not a small thing — it is what made one case's card
  // appear inside the next case's log, and it would reach a reader as a card changing after the
  // deployment it describes is gone.
  await sleep(600)

  assert.equal(observed.created.length + observed.patched.length, before, 'nothing is written after disposal')
})

test('a turn cut off by its output ceiling says the work did not finish', async () => {
  const scaffolded = await phoneHoldsIt()
  const { handle } = await startRun(scaffolded, 's_1')

  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'max-tokens' } },
  })
  await settle()

  // Every turn ends, so "stopped" alone cannot tell a finished one from one the ceiling cut in
  // half — and it is the one end reason where the reader has a decision to make.
  const content = JSON.stringify(cardFrom(handle))
  assert.match(content, /输出达到上限/, 'the ceiling is named')
  assert.match(content, /没有做完/, 'and so is what it means')
})

test('the map is capped, so a long-lived deployment does not remember every session forever', async () => {
  const scaffolded = await phoneHoldsIt()

  await startRun(scaffolded, 's_first')
  for (let index = 0; index < 70; index += 1) {
    scaffolded.emitToAll('session/event', { id: `s_${index}` }, { type: 'turn/start', data: { turn: 1 } })
  }
  await settle()

  const order = (await scaffolded.state()).activity.order
  assert.equal(order.length, 64, 'the map is capped')
  assert.equal(order.includes('s_first'), false, 'and the session nobody has run since is forgotten first')

  // A further event must not take a live neighbour's place: at the cap, a re-insertion that
  // removed the oldest key and then found no room to put anything back would evict one running
  // session per event, and each of them would lose its card and send a second message later.
  scaffolded.emitToAll('session/event', { id: 's_overflow' }, { type: 'turn/start', data: { turn: 1 } })
  await settle()
  assert.equal((await scaffolded.state()).activity.tracked, 64, 'and the cap still holds')
})

test('a card the platform accepted but never answered is not sent again', async () => {
  const scaffolded = await phoneHoldsIt()
  const before = observed.created.length

  // The failure a retry can make worse: the platform has the card, and this side never finds out.
  // Without an idempotency key the retry would send a second one, and the reader would be
  // notified twice about the same run.
  observed.loseNextAnswer = true
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  assert.equal(observed.lostAnswers, 1, 'the first send was accepted and its answer was lost')
  assert.equal(observed.created.length, before + 1, 'so one activity card exists')

  // The retry goes out under the same key, so the platform answers with what it already has.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, name: 'npm test' },
  })
  await sleep(5_200)
  assert.equal(observed.deduplicated, 1, 'the repeat was answered, not sent')
  assert.equal(observed.created.length, before + 1, 'and the reader has one card, not two')
})

test('two runs are two cards, each under its own key', async () => {
  const scaffolded = await phoneHoldsIt()

  await startRun(scaffolded, 's_1')
  await startRun(scaffolded, 's_2')

  // One key per card, and never a shared one: two keys that collided would make the platform
  // answer the second run with the first run's card.
  const carried = observed.created
    .filter((request) => {
      try {
        return JSON.parse(request.data.content).header.title.content.startsWith(ACTIVITY_TITLE)
      } catch {
        return false
      }
    })
    .map(request => request.data?.uuid)

  assert.equal(carried.length, 2, 'both runs were shown')
  assert.equal(carried.filter(key => key !== undefined).length, carried.length, 'every card carries a key')
  assert.equal(new Set(carried).size, carried.length, 'and no two share one')
})

test('a send that fails is retried, and not on the very next window', async () => {
  const scaffolded = await phoneHoldsIt()

  const before = lastDelivered()
  observed.failNextDelivery = 'the platform refused'
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  assert.equal(lastDelivered(), before, 'the first attempt failed, so no card exists yet')

  // Held back rather than retried immediately: a channel that is down must not be hammered at
  // the refresh rate, and a response lost after the platform accepted the card must not become
  // a second card a quarter of a second later.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 2, step: 1, name: 'npm test' },
  })
  await settle()
  assert.equal(lastDelivered(), before, 'the retry waits its turn')
})

test('the desk taking the person back before the write means no card after all', async () => {
  const scaffolded = await phoneHoldsIt()

  const before = lastDelivered()
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  // The desk answers inside the refresh window, which is long enough for that to happen. The card
  // was decided under phone priority and would be written under desk priority, and a message the
  // desk is not expecting is exactly the notification this plugin does not send.
  const approval = scaffolded.listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const answered = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  await answered
  await settle()

  assert.equal(lastDelivered(), before, 'the person went back to the desk before anything was written')
})

test('taking the phone over mid-turn picks the running turn up', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)

  // The turn starts while the desk has the person, so nothing is shown for it.
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  await settle()
  assert.equal(activityCard(), undefined, 'the desk had the person')

  await takeOverFromThePhone(scaffolded)
  // The turn is still running, and the phone is where the person now is. Waiting for the next
  // turn would be waiting for the wrong thing: this is the turn they took the phone over for.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'tool/call',
    data: { turn: 1, step: 1, name: 'npm test' },
  })
  await settle()

  const shown = activityCard()
  assert.ok(shown, 'the running turn is shown now')
  assert.match(JSON.stringify(shown.card), /npm test/, 'and shows where it is')
  assert.match(JSON.stringify(shown.card), /第 1 轮/, 'for the turn that was already running')
})

test('a run already in flight is taken on when the phone takes over', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)

  // A session running while the desk still had the person. It has no card — that is the point: the
  // desk could see it — and, before this, it had no record either.
  scaffolded.agents.set('s_running', { status: 'running' })
  await takeOverFromThePhone(scaffolded)

  // The takeover is the moment somebody picks the phone up to look at this run. Minting its card
  // lazily on the session's *next* event was not enough: for a run already in flight that next
  // event may be its last, so the first thing it did after the move was the one thing the phone
  // could not show.
  // The mint schedules a write, and the write is throttled to the refresh window: reading before it
  // has run would read the state from before the move.
  await settle()
  const shown = activityCard()
  assert.ok(shown, 'the run in flight is followed from the move, not from its next event')
  assert.match(JSON.stringify(shown.card), /处理中|已结束/, 'and the card says what it is doing')
})

test('a session that is not running is not taken on by the move', async () => {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)
  // Idle sessions are what the phone has nothing to say about: there is no run to follow, and a card
  // for one would be a message about nothing.
  scaffolded.agents.set('s_idle', { status: 'idle' })
  await takeOverFromThePhone(scaffolded)

  assert.equal(activityCard(), undefined, 'no card is minted for a session with no run')
})
