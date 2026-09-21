/**
 * The run record: one run's text, anchored where a person last spoke.
 *
 * This module is fed a session's events and read back by two cards, so its contract is what both of
 * them rely on. The cases are written against the module directly rather than through a deployment:
 * what is being pinned is which text a run holds and where it starts, which is not visible from a
 * rendered card once the bound has trimmed it.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunRecord, textOf, RUN_BUDGET } from '../run-record.js'
import { messagesFor } from '../messages.js'

/** A record with the deployment's copy, as the plugin composes it. */
const record = () => createRunRecord({ messages: () => messagesFor('zh') })

const humanSaid = (text, turn = 1) => ({
  type: 'user/message',
  surfaceOp: 'append',
  data: { turn, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const modelSaid = (text, { turn = 1, step = 1 } = {}) => ({
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { turn, step, message: { content: [{ type: 'text', text }] } },
})
const toolCalled = (name, { turn = 1, step = 1 } = {}) => ({
  type: 'tool/call',
  data: { turn, step, callId: 'c1', name },
})
const toolFailed = (reason, { turn = 1, step = 1 } = {}) => ({
  type: 'tool/result',
  surfaceOp: 'append',
  data: {
    turn,
    step,
    message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: reason }] }] },
    error: { name: 'ToolError', code: 'E1' },
  },
})
const turnEnded = (turn = 1) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

/**
 * One run's entries as plain lines.
 *
 * The record keeps what each entry *is* alongside its text, because a card that cannot show a whole
 * run has to give up its least useful part. These cases are about the lines themselves, so they read
 * the text and leave the kind to the cases that are about kinds.
 * @param runs - the record.
 * @param session - the session id.
 * @returns the run's lines.
 */
const lines = (runs, session) => runs.readRun(session).entries.map(entry => entry.text)

test('a run starts at the last thing a person said', () => {
  const runs = record()
  const session = { id: 's_1' }
  const feed = (event) => runs.observe(session, event)

  feed(humanSaid('第一件事'))
  feed(modelSaid('第一件事的答案'))
  feed(turnEnded())
  feed(humanSaid('第二件事', 2))
  feed(modelSaid('第二件事的答案', { turn: 2 }))

  const entries = lines(runs, 's_1')
  // What came before the last human message is not what they are asking about, and dropping it is
  // also what bounds this store without an arbitrary cap.
  assert.deepEqual(entries, ['第二件事', '第二件事的答案'], 'only the run the person last started')
  // And nothing keeps the earlier run: the card that reports it shows one run, so the record does
  // too — a discarded run is not a loss a reader can act on, and it is not counted as one.
  assert.equal(runs.readRun('s_1').dropped, 0, 'the run that is gone is not reported as lost')
})

test('a run holds what a person said, what the model said, and what it ran', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('把测试修好'))
  runs.observe(session, modelSaid('我先看失败的用例。'))
  runs.observe(session, toolCalled('pwsh'))
  runs.observe(session, toolFailed('Command failed with exit code 1'))
  runs.observe(session, turnEnded())

  const entries = lines(runs, 's_1')
  assert.deepEqual(entries, [
    '把测试修好',
    '我先看失败的用例。',
    // A tool is one line naming what sort of step it was — never its arguments, never its output.
    '▸ 运行命令',
    '**工具失败**：`pwsh` — Command failed with exit code 1',
  ])
})

test('a second turn in one session does not orphan the message that opens it', () => {
  const runs = record()
  const session = { id: 's_1' }
  // Two turns, one after the other — the ordinary shape of a session somebody keeps talking to.
  runs.observe(session, humanSaid('第一件'))
  runs.observe(session, { type: 'turn/start', data: { turn: 1 } })
  runs.observe(session, modelSaid('第一件的答案'))
  runs.observe(session, turnEnded(1))
  runs.observe(session, humanSaid('第二件'))
  runs.observe(session, { type: 'turn/start', data: { turn: 2 } })
  runs.observe(session, modelSaid('第二件的答案', { turn: 2 }))
  runs.observe(session, turnEnded(2))

  // A turn that has ended has to be known as ended, or the next `turn/start` looks like the same
  // turn: the run is never closed, and the message that opened the new turn is orphaned into a run
  // nothing reads — so the reader is shown an answer to a question the record cannot show.
  assert.deepEqual(lines(runs, 's_1'), ['第二件', '第二件的答案'], 'the new run keeps the message that opened it')
  // The run before it is gone rather than kept: one card reports one run, so there is no reader that
  // would show it, and the record does not pay to hold what nothing reads.
  assert.equal(
    lines(runs, 's_1').includes('第一件的答案'),
    false,
    'and the turn before it is not kept anywhere',
  )
})

test('the message that opened a run stays in it across the turns that follow', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('把剩下的两个 shard 做完'))
  // The message lands **before** the turn that claims it opens, so a rule that closes the previous
  // run on "is anything in it" archives the anchor itself here — and the reader loses the words the
  // whole run is an answer to.
  runs.observe(session, { type: 'turn/start', data: { turn: 1 } })
  assert.deepEqual(lines(runs, 's_1'), ['把剩下的两个 shard 做完'], 'the anchor survives the turn that claims it')

  runs.observe(session, modelSaid('先看一眼。'))
  runs.observe(session, turnEnded(1))
  // A second turn, with nothing said in between: the anchor belongs to the run, not to a turn.
  runs.observe(session, { type: 'turn/start', data: { turn: 2 } })
  runs.observe(session, modelSaid('又看了一处。', { turn: 2 }))
  runs.observe(session, turnEnded(2))

  assert.deepEqual(lines(runs, 's_1'), [
    '把剩下的两个 shard 做完',
    '先看一眼。',
    '又看了一处。',
  ], 'and no later turn archives it')
})

test('a tool with no known kind is named, not guessed at', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('用那个插件'))
  // A deployment that installs a plugin gets tools this table has never heard of. Naming the tool is
  // honest; guessing a kind would put a wrong word on the card, which is worse than a vague one.
  runs.observe(session, toolCalled('some_plugin_tool'))
  runs.observe(session, turnEnded())

  assert.deepEqual(lines(runs, 's_1'), ['用那个插件', '▸ 调用工具：`some_plugin_tool`'])
})

test('consecutive calls of one kind collapse into a counted line', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('读几个文件'))
  for (let index = 0; index < 5; index += 1) runs.observe(session, toolCalled('read'))
  // A different kind starts its own line, and the count does not carry across it.
  runs.observe(session, toolCalled('edit'))
  runs.observe(session, toolCalled('read'))
  runs.observe(session, turnEnded())

  // Five reads and one read say the same thing to a reader deciding what to do next, and the
  // nineteenth line of `读取` only costs the budget the prose needs.
  assert.deepEqual(lines(runs, 's_1'), [
    '读几个文件',
    '▸ 读取 ×5',
    '▸ 改动文件',
    '▸ 读取',
  ])
})

test('a failure ends the run of a kind', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('跑一下'))
  runs.observe(session, toolCalled('pwsh'))
  runs.observe(session, toolFailed('boom'))
  runs.observe(session, toolCalled('pwsh'))
  runs.observe(session, turnEnded())

  // The line before the failure carries it; counting a later call into that same line would hide
  // which invocation failed.
  assert.deepEqual(lines(runs, 's_1'), [
    '跑一下',
    '▸ 运行命令',
    '**工具失败**：`pwsh` — boom',
    '▸ 运行命令',
  ])
})

test('injected context does not anchor a run', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('问题'))
  runs.observe(session, modelSaid('回答'))
  // A plugin-injected message renders as folded context, not as the reader's own words, so it is
  // part of what the run was told rather than the question the run is answering.
  runs.observe(session, {
    type: 'user/message',
    surfaceOp: 'append',
    data: { turn: 1, source: { kind: 'plugin', plugin: 'somewhere' }, content: [{ type: 'text', text: '注入的上下文' }] },
  })
  runs.observe(session, turnEnded())

  assert.deepEqual(lines(runs, 's_1'), ['问题', '回答'], 'the run is still the one the person started')
})

test('a run is recorded whether or not a card was ever sent for it', () => {
  const runs = record()
  // No card, no priority, no handle — just events. This is the case the activity card could not
  // cover: a run at the desk, or the first run after the phone took over.
  runs.observe({ id: 'never-carded' }, humanSaid('在桌面跑的一轮'))
  runs.observe({ id: 'never-carded' }, modelSaid('做完了。'))
  runs.observe({ id: 'never-carded' }, turnEnded())

  assert.equal(runs.has('never-carded'), true, 'the session is recorded on its own account')
  assert.deepEqual(lines(runs, 'never-carded'), ['在桌面跑的一轮', '做完了。'])
})

test('the live stream is what fills a run whose message never came', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('开始'))
  runs.observeStream('s_1', { type: 'start', turn: 1, step: 1 })
  runs.observeStream('s_1', { type: 'chunk', chunk: { type: 'text-delta', text: '只有' } })
  runs.observeStream('s_1', { type: 'chunk', chunk: { type: 'text-delta', text: '实时片段' } })
  runs.observe(session, turnEnded())

  // The live frames are the only copy of that text until the step settles, and a run that streamed
  // everything and committed nothing would otherwise close empty.
  assert.equal(lines(runs, 's_1').includes('只有实时片段'), true, 'the streamed step reached the run')
})

test('a step whose text both streamed and settled is recorded once', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('开始'))
  runs.observeStream('s_1', { type: 'start', turn: 1, step: 1 })
  runs.observeStream('s_1', { type: 'chunk', chunk: { type: 'text-delta', text: '同一句话' } })
  runs.observe(session, modelSaid('同一句话'))
  runs.observe(session, turnEnded())

  const entries = lines(runs, 's_1')
  const appearances = entries.filter(entry => entry.includes('同一句话')).length
  assert.equal(appearances, 1, `the text is recorded once, not twice: ${appearances}`)
})

test('what the bound leaves out is counted, not silently lost', () => {
  const runs = record()
  const session = { id: 's_1' }
  runs.observe(session, humanSaid('很长的开头'))
  // Well past the budget, so the oldest entries have to go.
  for (let index = 0; index < 40; index += 1) {
    runs.observe(session, modelSaid(`第${index}段 ${'中'.repeat(200)}`))
  }
  runs.observe(session, turnEnded())

  const { dropped } = runs.readRun('s_1')
  const kept = lines(runs, 's_1')
  // A card that had to leave something out has to be able to say so: a reader who is not told cannot
  // tell a short run from a truncated one.
  assert.ok(dropped > 0, `the excess is counted: ${dropped}`)
  assert.equal(kept.includes('很长的开头'), false, 'and the oldest went first')
  assert.match(kept[kept.length - 1], /第39段/, 'keeping the end, which is what a reader wants')
})

test('the record is bounded, and forgets the coldest session first', () => {
  const runs = record()
  for (let index = 0; index < 70; index += 1) {
    runs.observe({ id: `s_${index}` }, humanSaid(`第${index}个会话`))
  }
  const order = runs.order()
  assert.equal(order.length, 64, 'the map is capped')
  assert.equal(order.includes('s_0'), false, 'and the session nobody has spoken in since is forgotten')
})

test('textOf reads blocks, a bare string, and nothing at all', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  // A tool result's content is blocks, not a string; reading it as one would render an object.
  assert.equal(textOf('bare'), 'bare')
  assert.equal(textOf(undefined), '')
  assert.equal(textOf([{ type: 'tool-call', name: 'x' }]), '')
})

test('the budget the record holds to is the one it says it is', () => {
  // Stated here so a change to the constant has to come past this line: the number is a product
  // decision about how much of a run a phone can usefully show.
  assert.equal(RUN_BUDGET, 8 * 1024)
})
