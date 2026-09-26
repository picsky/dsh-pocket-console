/**
 * A typed message that quotes a card waiting for an answer **is** that answer.
 *
 * The chat already carries instructions for a session, and the anchor is the card the message quotes.
 * The same anchor reaches the two cards that are not about a session at all: an approval and a question.
 * They are the cards that most need typing — a question can ask for anything, and the box on the card
 * is 1000 characters — and until this existed, quoting one was answered with "I cannot tell which
 * session this belongs to", because these cards carry a workspace and no session.
 *
 * Everything here is about one property: **a word becomes the payload the card itself would have sent**,
 * and then goes through the decoder a press goes through. The race with the desk, the mirror to the
 * browser half, the in-place rewrite of the card, the audit line — none of them know which way the
 * answer arrived, which is what makes them trustworthy. The other property is what is *not* reachable: a
 * typed answer can be `allowed-once` or `rejected` and nothing else, and the full-access switch — which
 * changes a session's policy and makes a deliberate press pass the platform's own confirmation — is
 * refused even as a word, because a word is not a deliberate press.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEscalation, approvalOutcomeFor } from '../escalation.js'
import { createInbound, decideMessage } from '../inbound.js'
import { messagesFor } from '../messages.js'
import { sleep, scaffold, bind, observed } from './support/harness.mjs'

/**
 * A channel whose deliveries name the message they landed in.
 *
 * The id matters here in a way the other suites do not care about: it is the only thing a typed answer
 * has to go on, so a stub that answered with an object would leave every case below testing nothing.
 * @returns the channel and the cards it was handed.
 */
function channelStub() {
  const cards = []
  return {
    cards,
    channel: {
      supportsForms: true,
      available: () => true,
      async deliver(view) {
        cards.push(view)
        return `om_card_${cards.length}`
      },
      async update() {},
      subscribe() { return () => {} },
      close() {},
    },
  }
}

/** An escalation over one stub channel, waiting for nothing: the card goes out at once. */
function machine(channel) {
  return createEscalation({
    log: { warn() {}, info() {}, debug() {} },
    channel,
    settings: () => ({ delaySeconds: 0, titlePrefix: 'DSH' }),
    mirror: { record() {}, report() {}, state: () => ({ sync: null, mirror: [] }) },
    // The real copy, because none of these cases assert on wording — and a card that cannot render is a
    // failure this file has no business hiding behind a hand-written dictionary.
    messages: () => messagesFor('zh'),
  })
}

test('the quoted card decides what the message means, before anything else does', () => {
  const requestAt = () => 'approval'
  assert.deepEqual(
    decideMessage({ text: '  允许  ', parentId: 'om_a', sessionOf: () => 's_1', requestAt }),
    { action: 'answer', handle: 'om_a', kind: 'approval', text: '允许' },
  )
  // Read ahead of the commands, on purpose: a question can ask for anything, and a question about what
  // a branch should be called has the answer `/new-parser`, which `\b` would let a command swallow.
  assert.deepEqual(
    decideMessage({ text: '/new 分支叫什么', parentId: 'om_q', sessionOf: () => undefined, requestAt: () => 'question' }),
    { action: 'answer', handle: 'om_q', kind: 'question', text: '/new 分支叫什么' },
  )
  // An empty quote answers nothing, and says so.
  assert.deepEqual(
    decideMessage({ text: '   ', parentId: 'om_a', sessionOf: () => undefined, requestAt }),
    { action: 'hint', copy: 'hintEmpty' },
  )
  // `/help` still wins: it asks about the channel, not about the card.
  assert.deepEqual(
    decideMessage({ text: '/help', parentId: 'om_a', sessionOf: () => undefined, requestAt }),
    { action: 'help' },
  )
  // A card that is not a live request is an instruction, exactly as it was before this existed.
  assert.deepEqual(
    decideMessage({ text: '接着做', parentId: 'om_r', sessionOf: () => 's_1', requestAt: () => undefined }),
    { action: 'reply', session: 's_1', text: '接着做' },
  )
  // And the request side is never consulted for a message that quotes nothing.
  assert.deepEqual(
    decideMessage({ text: '你好', sessionOf: () => undefined, requestAt: () => { throw new Error('asked') } }),
    { action: 'hint', copy: 'hintUnquoted' },
  )
})

test('an approval answers to exactly two words, and to nothing resembling a policy switch', () => {
  assert.equal(approvalOutcomeFor(' 允许 '), 'allowed-once')
  assert.equal(approvalOutcomeFor('ALLOW'), 'allowed-once')
  assert.equal(approvalOutcomeFor('拒绝'), 'rejected')
  assert.equal(approvalOutcomeFor(' Reject '), 'rejected')

  // Not a prefix, not a near miss, not a tone: every one of these decides nothing, and the reader is
  // told which two words work rather than having a grant guessed out of what they typed.
  const refused = [
    'ok', 'yes', 'no', '好', '行', '可以', '同意', '批准', '也许',
    '允许一次', '允许全权', 'allow-all', 'allowed-once', 'allowed-full', 'full',
    '', '   ', undefined, null,
  ]
  for (const text of refused) {
    assert.equal(approvalOutcomeFor(text), undefined, `${String(text)} is not an approval answer`)
  }
})

test('a typed answer settles an approval through the button\u2019s own decoder', async () => {
  const { channel, cards } = channelStub()
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate(
    { toolName: 'pwsh', reason: '需要写工作区', signal: new AbortController().signal },
    () => desktop.promise,
    'approval',
  )
  await sleep(30)
  assert.equal(cards.length, 1, 'the card went out, so there is a message to quote')

  // The card names the request, which is the whole mechanism: a typed message carries no payload.
  const handle = 'om_card_1'
  assert.equal(escalation.requestAt(handle), 'approval')
  assert.equal(escalation.answerByHandle({ handle, text: '允许' }).ok, true)
  assert.equal(await result, 'allowed-once', 'the race settles with the outcome a press gives')

  // Decided, so the card is answerable no longer — by a press, or by another word.
  assert.equal(escalation.requestAt(handle), undefined)
  assert.deepEqual(
    escalation.answerByHandle({ handle, text: '拒绝' }),
    { ok: false, reason: 'request-gone' },
  )
})

test('a word that is not an answer decides nothing at all, in either direction', async () => {
  const { channel } = channelStub()
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
    'approval',
  )
  await sleep(30)

  for (const text of ['ok', '好', '允许全权', 'allowed-full']) {
    assert.deepEqual(
      escalation.answerByHandle({ handle: 'om_card_1', text }),
      { ok: false, reason: 'not-an-answer' },
      `${text} settles nothing`,
    )
  }
  assert.equal(escalation.pending().length, 1, 'the request is still waiting rather than rejected by default')

  assert.equal(escalation.answerByHandle({ handle: 'om_card_1', text: '拒绝' }).ok, true)
  assert.equal(await result, 'rejected')
})

test('a quoted answer fills a question card in, one question at a time', async () => {
  const { channel } = channelStub()
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate({
    questions: [
      { id: 'name', question: '这个分支叫什么？' },
      { id: 'pick', question: '用哪个模板？', options: [{ label: '最小' }, { label: '完整' }] },
    ],
    signal: new AbortController().signal,
  }, () => desktop.promise, 'question')
  await sleep(30)

  // A question with no options takes the text as the answer itself.
  assert.equal(escalation.answerByHandle({ handle: 'om_card_1', text: 'feat/answer-a-quoted-card' }).ok, true)
  assert.equal(escalation.pending().length, 1, 'answered once, still waiting on the second')
  // The card is rewritten onto the next question, and the same message is still the one to answer on.
  assert.equal(escalation.requestAt('om_card_1'), 'question')

  // A question with options reads text that names one of them as that selection — trimmed and
  // case-insensitively, because a label is a name rather than a token.
  assert.equal(escalation.answerByHandle({ handle: 'om_card_1', text: ' 完整 ' }).ok, true)
  assert.deepEqual(await result, {
    answers: [
      { id: 'name', selected: [], custom: 'feat/answer-a-quoted-card' },
      { id: 'pick', selected: ['完整'] },
    ],
  })
})

test('a question answers text that names no option as the typed answer the card also offers', async () => {
  const { channel } = channelStub()
  const escalation = machine(channel)

  const desktop = Promise.withResolvers()
  const result = escalation.escalate({
    questions: [{ id: 'pick', question: '用哪个模板？', options: [{ label: '最小' }, { label: '完整' }] }],
    signal: new AbortController().signal,
  }, () => desktop.promise, 'question')
  await sleep(30)

  // The card offers an "other" box beside its options; a message that names none of them is that box.
  assert.equal(escalation.answerByHandle({ handle: 'om_card_1', text: '两个都要，先最小' }).ok, true)
  assert.deepEqual(await result, {
    answers: [{ id: 'pick', selected: [], custom: '两个都要，先最小' }],
  })
})

/**
 * The message side on its own, wired to an escalation machine that says what it was asked.
 * @param answer - what the escalation reports back for the answer it is handed.
 * @returns the module and the record of its calls.
 */
function inboundWith(answer) {
  const calls = { answered: [], lines: [] }
  const inbound = createInbound({
    log: { warn() {}, info() {}, debug() {} },
    messages: () => messagesFor('zh'),
    diagnostics: (line) => calls.lines.push(line),
    workspaces: { sessionOf: () => undefined },
    results: { async replyByHandle() { return { ok: true } }, sessionOfMessage: () => undefined },
    work: { async startFromMessage() { return 's_new' } },
    escalation: {
      requestAt: () => 'approval',
      answerByHandle({ handle, text }) {
        calls.answered.push({ handle, text })
        return answer
      },
    },
  })
  return { inbound, calls }
}

test('an answer that landed says nothing back; one that could not be used says which words work', async () => {
  // Silence is the confirmation: the card the reader quoted turns into the decided one on its own, and
  // this plugin's promise is that a round costs one message rather than two.
  const accepted = inboundWith({ ok: true })
  assert.equal(await accepted.inbound.handleMessage({ text: '允许', parentId: 'om_a', sender: 'ou_scanner' }), undefined)
  assert.deepEqual(accepted.calls.answered, [{ handle: 'om_a', text: '允许' }])
  assert.match(accepted.calls.lines.at(-1), /命中请求=approval/, 'and the log says what the message was taken for')

  // A word the card does not answer to is told so — the reader is one message away from the two that
  // work, and nothing was decided either way.
  const refused = inboundWith({ ok: false, reason: 'not-an-answer' })
  const told = await refused.inbound.handleMessage({ text: '好', parentId: 'om_a', sender: 'ou_scanner' })
  assert.ok(told.reply.includes('允许'), `the refusal names the words that work: ${told.reply}`)

  // And a request that is no longer open is said out loud rather than left looking answered.
  const gone = inboundWith({ ok: false, reason: 'request-gone' })
  const left = await gone.inbound.handleMessage({ text: '允许', parentId: 'om_a', sender: 'ou_scanner' })
  assert.equal(left.reply, messagesFor('zh').messageAnswerGone)
})

test('a card that is not a live request answers nothing', () => {  const { channel } = channelStub()
  const escalation = machine(channel)

  // A result card, an activity card, a request already decided, or a message that is not ours at all.
  assert.equal(escalation.requestAt('om_result_card'), undefined)
  assert.deepEqual(
    escalation.answerByHandle({ handle: 'om_result_card', text: '允许' }),
    { ok: false, reason: 'request-gone' },
  )
  assert.deepEqual(escalation.answerByHandle({}), { ok: false, reason: 'request-gone' })
  assert.deepEqual(escalation.answerByHandle({ handle: undefined, text: 'x' }), { ok: false, reason: 'request-gone' })
})

test('a real approval card is answered by quoting it, through the plugin', async () => {
  // The end-to-end half: the real plugin, the real channel handler, a real delivered card. What only
  // this case can prove is the join — the platform's `parent_id` names the card, the card names the
  // request, and the word settles the race the desk is still holding open.
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', reason: '需要写工作区', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  const handle = observed.delivered.at(-1)?.handle
  assert.ok(handle !== undefined, 'the approval card went out')

  await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        chat_type: 'p2p',
        message_id: 'om_typed_answer',
        chat_id: 'oc_p2p',
        message_type: 'text',
        parent_id: handle,
        content: JSON.stringify({ text: '允许' }),
      },
      sender: { sender_id: { open_id: 'ou_scanner' } },
    },
  })

  assert.equal(await result, 'allowed-once', 'the word decided the same request a button decides')
  await sleep(20)
  // And the card says what happened, rather than still asking: this is the confirmation the reader
  // gets instead of a second message.
  const rewritten = JSON.stringify(observed.patched.at(-1) ?? {})
  assert.ok(
    rewritten.includes(messagesFor('zh').allowedOnce),
    `the card was rewritten to its outcome: ${rewritten.slice(0, 200)}`,
  )
})

test('a stranger\u2019s quoted answer reaches nothing', async () => {
  // The typed path must be exactly as unreachable as the button path: only the bound recipient can turn
  // a word into a decision. Anyone else's message is not even served — the channel refuses it before the
  // core sees it, which is why this asserts on the request rather than on a toast.
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  const handle = observed.delivered.at(-1)?.handle

  await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        chat_type: 'p2p',
        message_id: 'om_typed_stranger',
        chat_id: 'oc_other',
        message_type: 'text',
        parent_id: handle,
        content: JSON.stringify({ text: '允许' }),
      },
      sender: { sender_id: { open_id: 'ou_someone_else' } },
    },
  })

  assert.equal(observed.patched.length, 0, 'the stranger\u2019s message changed no card')
  // Only the desk can settle this request now: had the word above decided it, the race would already
  // have resolved as `allowed-once` and the desk's own answer would have arrived too late to be read.
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected', 'and the desk is still the side that decides it')
})
