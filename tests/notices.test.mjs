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
  sentCard,
  observed,
} from './support/harness.mjs'

/**
 * Drive one session through the recorded event sequence: a person starts it, a
 * tool-calling message is process, the last message is the answer, and the turn
 * ends.
 * @param emit - the `session/event` listener.
 * @param id - session id.
 * @param answer - the answer text.
 */
function runTurn(emit, id, answer = '构建已经通过。') {
  emit({ id }, { type: 'user/message', data: { source: { kind: 'user' } } })
  emit({ id }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: '我先看看' }, { type: 'tool-call', name: 'pwsh' }] } },
  })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'pwsh' }] } },
  })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: answer }] } },
  })
  emit({ id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
  const toast = await clickCard(submit, { value: '接着把文档补上' })
  assert.equal(toast.toast.content, '已发送给 agent')
  await sleep(10)
  assert.equal(followed.length, 1)
  assert.equal(followed[0].content[0].text, '接着把文档补上')
  assert.deepEqual(followed[0].source, { kind: 'user' },
    'the reader speaking through a remote surface, as the harness ACP client records it')

  const replayed = await clickCard(submit, { value: '再来一次' })
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

