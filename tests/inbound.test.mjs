/**
 * The typed half of the phone: what a message in the chat means, and what comes back.
 *
 * A card's `input` is capped at 1000 characters by the platform, which is enough for a reply and not
 * enough for the first prompt of a new session. So a message can carry an instruction, and the anchor
 * is `parent_id`: the platform sends it only when a message replies to another, and it is that
 * message's id — which for a card is an id we already hold.
 *
 * The rules the person who uses this chose are all here: **a message that quotes nothing is not acted
 * on** (guessing a session would be worse than doing nothing), commands are the exception, and a
 * quoted instruction that lands says nothing back because the card it quoted turns into the running
 * card on its own.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { HINT_INTERVAL_MS, createInbound, decideMessage } from '../inbound.js'
import { sleep, scaffold, bind, observed } from './support/harness.mjs'

/** The copy the module reads. Only the keys a case can reach are named. */
const COPY = {
  helpText: 'help text',
  hintUnquoted: 'unquoted hint',
  hintEmpty: 'empty hint',
  hintOrphanNew: 'orphan new hint',
  hintEmptyNew: 'empty new hint',
  messageReplyFailed: reason => `failed: ${String(reason)}`,
  messageNewFailed: 'new failed',
  logMessageFailed: 'message failed',
  logMessageReplyFailed: 'reply failed',
  logInstructionFailed: 'instruction failed',
  logMessageNewFailed: 'new log failed',
  logMessageRepeat: 'repeat',
}

/**
 * The module wired to stubs that record what it did.
 * @param options - how the reply path and the next-task path should behave.
 * @returns the module and the record of its calls.
 */
function setup({ reply = { ok: true }, started = 's_new', failsToStart = false, sessionOf, clock } = {}) {
  const calls = { replied: [], started: [], lines: [] }
  const inbound = createInbound({
    log: { warn() {}, info() {}, debug() {} },
    messages: () => COPY,
    diagnostics: (line) => calls.lines.push(line),
    workspaces: { sessionOf: (handle) => (sessionOf === undefined ? undefined : sessionOf(handle)) },
    results: {
      async replyByHandle({ handle, text }) { calls.replied.push({ handle, text }); return reply },
      sessionOfMessage: () => undefined,
    },
    work: {
      async startFromMessage(session, text) {
        calls.started.push({ session, text })
        // A start that failed returns nothing; `undefined` cannot be asked for through a default
        // parameter, so the case that needs it says so with a flag.
        return failsToStart ? undefined : started
      },
    },
    now: () => (clock === undefined ? 0 : clock()),
  })
  return { inbound, calls }
}

test('a quoted card means the instruction goes to that card\u2019s session', () => {
  assert.deepEqual(
    decideMessage({ text: '  接着做  ', parentId: 'om_card', sessionOf: () => 's_1' }),
    { action: 'reply', session: 's_1', text: '接着做' },
  )
})

test('a message that quotes nothing is not routed anywhere', () => {
  assert.deepEqual(decideMessage({ text: '你好', sessionOf: () => undefined }), { action: 'hint', copy: 'hintUnquoted' })
  // Even when a card is known, an unquoted message has no target: there is nothing to fall back to.
  assert.deepEqual(decideMessage({ text: '你好', parentId: '', sessionOf: () => 's_1' }), { action: 'hint', copy: 'hintUnquoted' })
  // And a quoted message whose card we do not know is a hint, never a guess.
  assert.deepEqual(decideMessage({ text: '接着做', parentId: 'om_unknown', sessionOf: () => undefined }), { action: 'hint', copy: 'hintUnquoted' })
})

test('/new needs a quoted card, because the new session inherits that workspace', () => {
  assert.deepEqual(
    decideMessage({ text: '/new 重构一下解析器', parentId: 'om_card', sessionOf: () => 's_1' }),
    { action: 'new', session: 's_1', prompt: '重构一下解析器' },
  )
  assert.deepEqual(decideMessage({ text: '/new 重构一下', sessionOf: () => undefined }), { action: 'hint', copy: 'hintOrphanNew' })
  assert.deepEqual(decideMessage({ text: '/new', parentId: 'om_card', sessionOf: () => 's_1' }), { action: 'hint', copy: 'hintEmptyNew' })
  assert.deepEqual(decideMessage({ text: '/new   ', parentId: 'om_card', sessionOf: () => 's_1' }), { action: 'hint', copy: 'hintEmptyNew' })
})

test('/help is answered without quoting anything', () => {
  assert.deepEqual(decideMessage({ text: '/help', sessionOf: () => undefined }), { action: 'help' })
  assert.deepEqual(decideMessage({ text: '  /HELP  ', sessionOf: () => undefined }), { action: 'help' })
})

test('an empty quote says so instead of sending an empty instruction', () => {
  assert.deepEqual(decideMessage({ text: '   ', parentId: 'om_card', sessionOf: () => 's_1' }), { action: 'hint', copy: 'hintEmpty' })
})

test('a quoted instruction reaches its session and says nothing back', async () => {
  const { inbound, calls } = setup({ sessionOf: () => 's_1' })
  const answer = await inbound.handleMessage({ text: '接着做', parentId: 'om_card', sender: 'ou_a', messageType: 'text' })
  assert.deepEqual(calls.replied, [{ handle: 'om_card', text: '接着做' }], 'the instruction went out under the quoted id')
  assert.equal(answer, undefined, 'the card turning into the running card is the whole confirmation')
  assert.match(calls.lines.join('\n'), /命中卡=是/, 'and the deployment log says the card was recognized')
})

test('an instruction that did not go out is reported, in words', async () => {
  const { inbound } = setup({ reply: { ok: false, reason: 'not-sent' }, sessionOf: () => 's_1' })
  const answer = await inbound.handleMessage({ text: '接着做', parentId: 'om_card', sender: 'ou_a' })
  assert.equal(answer.reply, 'failed: not-sent', 'the reader is told, rather than left waiting')
})

test('/new starts a session in the quoted card\u2019s workspace', async () => {
  const { inbound, calls } = setup({ sessionOf: () => 's_1' })
  const answer = await inbound.handleMessage({ text: '/new 写个测试', parentId: 'om_card', sender: 'ou_a' })
  assert.deepEqual(calls.started, [{ session: 's_1', text: '写个测试' }], 'the quoted card names the workspace')
  assert.equal(answer, undefined, 'and a started session needs no announcement')
})

test('a new session that could not start says so', async () => {
  const { inbound } = setup({ failsToStart: true, sessionOf: () => 's_1' })
  const answer = await inbound.handleMessage({ text: '/new 写个测试', parentId: 'om_card', sender: 'ou_a' })
  assert.equal(answer.reply, 'new failed')
})

test('/help answers with the help text', async () => {
  const { inbound } = setup()
  assert.equal((await inbound.handleMessage({ text: '/help', sender: 'ou_a' })).reply, 'help text')
})

test('the unquoted hint is given once per window, not once per message', async () => {
  let at = 1_000_000
  const { inbound, calls } = setup({ clock: () => at })
  const first = await inbound.handleMessage({ text: '你好', sender: 'ou_a' })
  assert.equal(first.reply, 'unquoted hint', 'the first message is answered')
  const second = await inbound.handleMessage({ text: '在吗', sender: 'ou_a' })
  assert.equal(second, undefined, 'a second one inside the window is not')
  // Another person has their own window.
  assert.equal((await inbound.handleMessage({ text: '你好', sender: 'ou_b' })).reply, 'unquoted hint', 'and the window is per person')
  at += HINT_INTERVAL_MS + 1
  const later = await inbound.handleMessage({ text: '你好', sender: 'ou_a' })
  assert.equal(later.reply, 'unquoted hint', 'and the window opens again')
  assert.ok(calls.lines.length >= 4, 'every message is still written to the log')
})

test('a quoted message that is a repeat is served once, through the channel', async () => {
  // The end-to-end half: the real plugin, the real channel handler, a real delivered card. This is
  // the case that proves the anchor — `parent_id` is the card's own message id — and the dedupe the
  // platform's own page asks for ("use `message_id`, do not rely on `event_id`").
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route, { openId: 'ou_scanner' })
  const followed = []
  agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  const emit = listenerOf('session/event').handler
  emit({ id: 's_1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } })
  emit({ id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: '构建已经通过。' }] } },
  })
  emit({ id: 's_1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(1100)

  const delivered = observed.delivered.at(-1)
  assert.ok(delivered !== undefined, 'a result card went out')
  const handle = delivered.handle
  const message = {
    chat_type: 'p2p',
    message_id: 'om_typed_1',
    chat_id: 'oc_p2p',
    message_type: 'text',
    parent_id: handle,
    content: JSON.stringify({ text: '把测试也补上' }),
  }
  const event = () => observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: { message, sender: { sender_id: { open_id: 'ou_scanner' } } },
  })

  await event()
  await event()
  const texts = followed.map(entry => JSON.stringify(entry))
  assert.equal(texts.filter(text => text.includes('把测试也补上')).length, 1, 'the instruction was handed over exactly once')
})
