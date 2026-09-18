/**
 * Result notices: delivery, suppression while off or busy, and the per-session cooldown.
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
  sentCard,
  observed,
  SAME_ORIGIN,
} from './support/harness.mjs'

/**
 * Drive one session through the recorded event sequence: a person starts it, a
 * tool-calling message is process, the last message is the answer, and the turn
 * ends.
 * @param emit - the `session/event` listener.
 * @param id - session id.
 * @param answer - the answer text.
 * @param options - whether the round opens with something a person said, and
 *   which turn number it is.
 */
function runTurn(emit, id, answer = '构建已经通过。', { said = true, turn = 1 } = {}) {
  if (said) emit({ id }, { type: 'user/message', data: { source: { kind: 'user' } } })
  emit({ id }, { type: 'turn/start', data: { turn } })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn, message: { content: [{ type: 'text', text: '我先看看' }, { type: 'tool-call', name: 'pwsh' }] } },
  })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn, message: { content: [{ type: 'tool-call', name: 'pwsh' }] } },
  })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn, message: { content: [{ type: 'text', text: answer }] } },
  })
  emit({ id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}


test('sends a stopped answer to the phone and takes the next instruction back', async () => {
  const { route, listenerOf, agents, infos } = await scaffold({ resultNotify: 'idle' })
  await bind(route, { openId: 'ou_scanner' })
  const followed = []
  agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_1')
  assert.equal(observed.created.length, 0, 'nothing is sent before the quiet window elapses')
  await sleep(1100)

  // The notice carries the answer alone: the tool-calling messages stay behind.
  const card = sentCard()
  assert.ok(JSON.stringify(card).includes('构建已经通过。'), 'the answer reaches the card')
  assert.ok(!JSON.stringify(card).includes('我先看看'), 'a tool-calling message is process, not the answer')
  assert.ok(infos.some(message => message.includes('结果已发送')), 'the delivery is logged')

  const submit = callbackValues(card).find(value => value.submit === true)
  // The card names the control and the submit reports the name it used, which is what
  // the notice decoder reads — so a reply typed into the card is not silently dropped.
  const [answer] = controlNames(card)
  assert.equal(submit.submits?.value, answer, 'the notice card reports the name it used')
  const toast = await clickCard(submit, { [answer]: '接着把文档补上' })
  assert.equal(toast.toast.content, '已发送给 agent')
  await sleep(10)
  assert.equal(followed.length, 1)
  assert.equal(followed[0].content[0].text, '接着把文档补上')
  assert.deepEqual(followed[0].source, { kind: 'user' },
    'the reader speaking through a remote surface, as the harness ACP client records it')

  const replayed = await clickCard(submit, { [answer]: '再来一次' })
  assert.equal(replayed.toast.type, 'warning', 'a notice id is single-use')
  assert.equal(followed.length, 1)
})


test('stays silent while notifications are off or the session is still working', async () => {
  const off = await scaffold()
  await bind(off.route, { openId: 'ou_scanner' })
  const offEmit = off.listenerOf('session/event').handler
  runTurn(offEmit, 's_off')
  await sleep(1100)
  assert.equal(observed.created.length, 0, 'the default configuration sends no result notices')

  const busy = await scaffold({ resultNotify: 'idle' })
  await bind(busy.route, { openId: 'ou_scanner' })
  busy.agents.set('s_busy', { status: 'running', followup: () => {} })
  const busyEmit = busy.listenerOf('session/event').handler
  runTurn(busyEmit, 's_busy')
  await sleep(1100)
  assert.equal(observed.created.length, 0, 'a working agent is offered nothing')

  // A delegated session reports through the session that asked for it.
  const delegated = await scaffold({ resultNotify: 'idle' })
  await bind(delegated.route, { openId: 'ou_scanner' })
  delegated.agents.set('s_sub', { status: 'idle', followup: () => {} })
  const subEmit = delegated.listenerOf('session/event').handler
  subEmit({ id: 's_sub' }, { type: 'turn/start', data: { turn: 1 } })
  subEmit({ id: 's_sub' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: '子任务完成' }] } },
  })
  subEmit({ id: 's_sub' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(1100)
  assert.equal(observed.created.length, 0, 'a session no person started is not reported')
})


test('holds the next notice until the cooldown has passed', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle', resultNotifyCooldownSeconds: 600 })
  await bind(route, { openId: 'ou_scanner' })
  agents.set('s_2', { status: 'idle', followup: () => {} })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_2', '第一轮完成。')
  await sleep(1100)
  assert.equal(observed.created.length, 1)

  emit({ id: 's_2' }, { type: 'turn/start', data: { turn: 2 } })
  emit({ id: 's_2' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 2, message: { content: [{ type: 'text', text: '第二轮完成。' }] } },
  })
  emit({ id: 's_2' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await sleep(1100)
  assert.equal(observed.created.length, 1, 'the same session stays quiet inside the cooldown')
})

test('a notice stops taking replies once the session has new input', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route, { openId: 'ou_scanner' })
  const followed = []
  agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_1')
  await sleep(1100)
  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The reader types at the desk. That result is no longer the session's latest
  // word, so replying to it would inject an instruction written against it.
  emit({ id: 's_1' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  await sleep(20)
  assert.equal(observed.patched.length, 1, 'the card says why it stopped')
  assert.match(JSON.stringify(JSON.parse(observed.patched[0].data.content)), /已有新消息/)

  const refused = await clickCard(submit, { [answer]: '接着做' })
  assert.equal(refused.toast.type, 'warning')
  assert.match(refused.toast.content, /已过期/)
  await sleep(10)
  assert.deepEqual(followed, [], 'a superseded notice injects nothing')
})

test('a newer notice retires the one before it', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle', resultNotifyCooldownSeconds: 0 })
  await bind(route, { openId: 'ou_scanner' })
  const followed = []
  agents.set('s_3', { status: 'idle', followup: (message) => { followed.push(message) } })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_3', '第一轮完成。', { turn: 1 })
  await sleep(1100)
  const firstCard = sentCard()
  const first = callbackValues(firstCard).find(value => value.submit === true)
  const [firstName] = controlNames(firstCard)

  // A later round with nothing said in between, so only superseding can retire
  // the first card rather than the new-input rule.
  runTurn(emit, 's_3', '第二轮完成。', { said: false, turn: 2 })
  await sleep(1100)
  assert.equal(observed.created.length, 2, 'the newest result is offered too')
  const secondCard = JSON.parse(observed.created[1].data.content)
  const second = callbackValues(secondCard).find(value => value.submit === true)
  const [secondName] = controlNames(secondCard)

  const stale = await clickCard(first, { [firstName]: '按第一轮来' })
  assert.match(stale.toast.content, /已过期/)
  await sleep(10)
  assert.deepEqual(followed, [], 'the older notice injects nothing')

  const live = await clickCard(second, { [secondName]: '按第二轮来' })
  assert.equal(live.toast.content, '已发送给 agent')
  await sleep(10)
  assert.equal(followed.length, 1, 'the newest notice still works')
})

test('a notice you come back to later is still an offer', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route, { openId: 'ou_scanner' })
  const followed = []
  agents.set('s_4', { status: 'idle', followup: (message) => { followed.push(message) } })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_4')
  await sleep(1100)
  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // Nothing replaced the result and nobody replied, so elapsed time decides
  // nothing: a notice answered much later is still answered, not refused.
  await sleep(1200)
  const accepted = await clickCard(submit, { [answer]: '再改一下' })
  assert.equal(accepted.toast.type, 'success')
  await sleep(10)
  assert.equal(followed.length, 1, 'a late reply still reaches the session')
})

test('a long result is clipped so the notice still arrives', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route, { openId: 'ou_scanner' })
  agents.set('s_big', { status: 'idle', followup: () => {} })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_big', '结'.repeat(20000))
  await sleep(1100)

  // A result too large for a card would be refused, and the reader would get no
  // notice at all — worse than a clipped one that says it clipped.
  const content = observed.created[0].data.content
  assert.ok(
    Buffer.byteLength(content, 'utf8') < 12 * 1024,
    `the notice stays well inside the platform limit: ${Buffer.byteLength(content, 'utf8')} bytes`,
  )
  assert.match(content, /内容过长已截断/)
  assert.ok(
    callbackValues(JSON.parse(content)).some(value => value.submit === true),
    'and it still takes the next instruction',
  )
})

test('the notice copy follows the deployment language', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle', locale: 'en' })
  await bind(route, { openId: 'ou_scanner' })
  const followed = []
  agents.set('s_en', { status: 'idle', followup: (message) => { followed.push(message) } })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_en', 'The build passed.')
  await sleep(1100)
  const card = sentCard()
  const rendered = JSON.stringify(card)
  assert.match(rendered, /Result/)
  assert.match(rendered, /Reply to this message/)
  assert.match(rendered, /Send to the agent/)

  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)
  const settled = await clickCard(submit, { [answer]: 'Ship it.' })
  assert.equal(settled.toast.content, 'Sent to the agent')
  await sleep(10)
  assert.equal(followed.length, 1)
})

test('the deployment log follows the deployment language too', async () => {
  // The log is read by whoever diagnoses *this* deployment, so it follows the same
  // locale the cards do. Half the story in one language and half in another is what
  // a reader who set `zh` should not have to work around.
  const mirrored = async (locale) => {
    const { route, debugs } = await scaffold({ locale })
    await route('POST', '/__pocket/mirror', SAME_ORIGIN, { status: 'loaded' })
    return debugs.join('\n')
  }

  const english = await mirrored('en')
  assert.match(english, /desktop mirror: loaded/, `the English deployment logs English: ${english}`)
  assert.equal(/桌面镜像/.test(english), false, 'and carries no Chinese line')

  const chinese = await mirrored('zh')
  assert.match(chinese, /桌面镜像：loaded/, `the Chinese deployment logs Chinese: ${chinese}`)
  assert.equal(/desktop mirror/.test(chinese), false, 'and carries no English line')
})


test('a notice card whose process is gone stops taking a reply', async () => {
  // Notices live in memory too, so after a restart the card still invited an instruction
  // and answering it produced a toast and nothing else. The press names its message, so
  // the card is rewritten to stop offering the reply.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.agents.set('s_1', { status: 'idle', followup: () => {} })
  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The restart: the same deployment loads again with no notice behind it.
  await scaffold({ resultNotify: 'idle' }, { stored })

  const refused = await clickCard(submit, { [answer]: '接着做' })
  assert.equal(refused.toast.type, 'warning', 'the reply is refused')
  assert.match(refused.toast.content, /已过期/, 'and says the result expired')
  await sleep(20)

  const dead = JSON.parse(observed.patched.at(-1).data.content)
  assert.match(JSON.stringify(dead), /该结果已过期/, 'the card says the notice is over')
  assert.deepEqual(callbackValues(dead), [], 'and offers nothing left to reply with')
})


