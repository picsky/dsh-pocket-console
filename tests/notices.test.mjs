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

  runTurn(emit, 's_big', '结'.repeat(60_000))
  await sleep(1100)

  // A result too large for a card would be refused, and the reader would get no
  // notice at all — worse than a clipped one that says it clipped.
  const content = observed.created[0].data.content
  assert.ok(
    Buffer.byteLength(content, 'utf8') < 150 * 1024,
    `the notice stays inside the platform limit: ${Buffer.byteLength(content, 'utf8')} bytes`,
  )
  assert.match(content, /内容过长已截断/)
  assert.ok(
    callbackValues(JSON.parse(content)).some(value => value.submit === true),
    'and it still takes the next instruction',
  )
})

test('a notice names the workspace of the session it reports on', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route)
  // The result notice reads the workspace through the live agent it is watching, which
  // is the one path that works for a session that is running right now.
  agents.set('s_ws', {
    status: 'idle',
    followup: () => {},
    session: { header: { cwd: 'C:\\work\\my-app' } },
  })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_ws', '构建通过了。')
  await sleep(1100)
  assert.equal(sentCard().header.title.content, 'DSH 结果 · my-app', 'the title names the workspace')
})

test('a notice with no workspace to name keeps the title it always had', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route)
  // A session whose header carries no working directory. That is real — a session can
  // be created outside any workspace — and it must not leave a bare separator on the
  // card or invent a name for one.
  agents.set('s_bare', { status: 'idle', followup: () => {}, session: { header: {} } })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_bare', '构建通过了。')
  await sleep(1100)
  assert.equal(sentCard().header.title.content, 'DSH 结果', 'the title is exactly what it was before')
})

test('a notice retired as stale still says which session it was about', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route)
  agents.set('s_ws', {
    status: 'idle',
    followup: () => {},
    session: { header: { cwd: '/work/my-app' } },
  })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_ws', '构建通过了。')
  await sleep(1100)
  const card = sentCard()
  // The notice is retired from this side when somebody speaks in the session, which is
  // the same rewrite a press after a restart meets: the card is rewritten where it lies.
  assert.ok(callbackValues(card).some(value => value.submit === true), 'the card took a reply first')
  emit({ id: 's_ws' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  await sleep(20)
  const retired = JSON.parse(observed.patched.at(-1).data.content)

  assert.equal(retired.header.title.content, 'DSH 结果 · my-app', 'the retirement keeps the workspace')
  assert.match(JSON.stringify(retired), /已有新消息/, 'and still says why it stopped taking replies')
})

test('a card the phone presses after its notice is gone is still named', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route)
  agents.set('s_ws', {
    status: 'idle',
    followup: () => {},
    session: { header: { cwd: '/work/my-app' } },
  })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_ws', '构建通过了。')
  await sleep(1100)
  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The press arrives after this side stopped holding the notice — a restart, or a
  // supersession — so there is no record to read a workspace from, and the message the
  // press carries is the only thing that can name the card.
  emit({ id: 's_ws' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  await sleep(20)
  observed.patched.length = 0
  const refused = await clickCard(submit, { [answer]: '接着补文档' })
  assert.equal(refused.toast.content, '该结果已过期', 'the press is refused')

  const stale = JSON.parse(observed.patched.at(-1).data.content)
  assert.equal(stale.header.title.content, 'DSH 结果 · my-app', 'and the stale card is still named')
  assert.match(JSON.stringify(stale), /不再有效/, 'while saying only what this side knows')
})

test('the card the reader replied on is renamed in place, keeping the workspace', async () => {
  const { route, listenerOf, agents } = await scaffold({ resultNotify: 'idle' })
  await bind(route)
  agents.set('s_ws', {
    status: 'idle',
    followup: () => {},
    session: { header: { cwd: '/work/my-app' } },
  })
  const emit = listenerOf('session/event').handler

  runTurn(emit, 's_ws', '构建通过了。')
  await sleep(1100)
  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  const settled = await clickCard(submit, { [answer]: '接着补文档' })
  assert.equal(settled.toast.content, '已发送给 agent')
  // The run's card is written on the refresh window, not inside the press.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (observed.patched.length > 0) break
    await sleep(25)
  }

  // The rewrite is what the reader is left looking at, so it has to agree with the card it replaces
  // rather than becoming anonymous the moment it is answered — and the card it is now is the one the
  // run it started is shown in.
  const rewritten = JSON.parse(observed.patched.at(-1).data.content)
  assert.equal(rewritten.header.title.content, 'DSH 执行中 · my-app', 'the card keeps the workspace')
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


test('without durable storage a notice is still refused after a restart', async () => {
  // The medium is what carries a notice across a restart, so a deployment that composes
  // no storage hub keeps the old behaviour — and a press still retires the card rather
  // than answering with a toast alone.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const services = ['settings', 'webServer']
  const first = await scaffold({ resultNotify: 'idle' }, { stored, services })
  first.agents.set('s_1', { status: 'idle', followup: () => {} })
  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The restart: the same deployment loads again with no notice behind it.
  await scaffold({ resultNotify: 'idle' }, { stored, services })

  const refused = await clickCard(submit, { [answer]: '接着做' })
  assert.equal(refused.toast.type, 'warning', 'the reply is refused')
  assert.match(refused.toast.content, /已过期/, 'and says the result expired')
  await sleep(20)

  const dead = JSON.parse(observed.patched.at(-1).data.content)
  assert.match(JSON.stringify(dead), /这条通知已不再有效/,
    'the card says the notice is not live, without inventing a reason')
  assert.deepEqual(callbackValues(dead), [], 'and offers nothing left to reply with')
})


test('a notice survives a restart and still takes a reply', async () => {
  // A notice keeps taking replies until the session it reports on moves on, with no time
  // limit. The registry that decided that lived only in memory, so an ordinary restart
  // withdrew every outstanding notice and the card blamed an expiry that never happened.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.sessionQuery.exists('s_1', 5)
  first.agents.set('s_1', { status: 'idle', followup: () => {} })
  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The rid is also the record key, and the storage layout turns a key into a path
  // segment — so the grammar is load-bearing, not cosmetic.
  assert.match(submit.nid, /^[a-zA-Z0-9_-]+$/,
    'a notice id doubles as a path-safe durable key')

  // The restart: same deployment and same durable medium. A session comes back dormant —
  // a restart leaves no agent running — which is a state the live path already answers
  // honestly, so it must not be mistaken for the session being gone.
  const second = await scaffold({ resultNotify: 'idle' }, { stored, keepDurable: true })
  assert.equal(second.agents.size, 0, 'a restart leaves no agent running')
  const dormant = await clickCard(submit, { [answer]: '先试一下' })
  assert.match(dormant.toast.content, /会话已不在运行/, 'a dormant session is named as such')
  assert.equal(dormant.toast.content.includes('已过期'), false, 'not as an expired result')

  // The desk opens the session again, which is what gives it a live agent.
  const followed = []
  second.agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  await sleep(30)

  const accepted = await clickCard(submit, { [answer]: '接着把文档补上' })
  assert.equal(accepted.toast.content, '已发送给 agent', 'the reply is taken after a restart')
  await sleep(10)
  assert.equal(followed.length, 1, 'and it reaches the session')
  assert.equal(followed[0].content[0].text, '接着把文档补上')
})


test('a notice whose session moved on while the process was down is retired', async () => {
  // What happens while DSH is not running leaves no trace in it, so the rule cannot be
  // read off an event stream — it is asked of the session's own log, and the card gets
  // the same reason the live path would have given it.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.sessionQuery.exists('s_1', 5)
  first.agents.set('s_1', { status: 'idle', followup: () => {} })
  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)
  const submit = callbackValues(sentCard()).find(value => value.submit === true)

  // Somebody speaks at seq 9, after the notice went out at seq 5 — while nothing is
  // running to see it, which is the whole reason the question is asked of the log.
  first.sessionQuery.personSpoke('s_1', 9)
  const second = await scaffold({ resultNotify: 'idle' }, { stored, keepDurable: true })
  assert.equal(second.agents.size, 0, 'nothing is running after the restart')
  await sleep(40)

  const retired = JSON.parse(observed.patched.at(-1).data.content)
  assert.match(JSON.stringify(retired), /该结果已有新消息/, 'the card says the session moved on')
  assert.deepEqual(callbackValues(retired), [], 'and it stops offering the reply')
})


test('a notice whose session is gone is retired, not left waiting', async () => {
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.agents.set('s_gone', { status: 'idle', followup: () => {} })
  runTurn(first.listenerOf('session/event').handler, 's_gone')
  await sleep(1100)
  assert.equal(observed.created.length, 1, 'the notice went out')

  // The session itself is gone from the durable corpus, so there is nothing to instruct.
  const second = await scaffold({ resultNotify: 'idle' }, { stored, keepDurable: true })
  await sleep(40)

  const retired = JSON.parse(observed.patched.at(-1).data.content)
  assert.match(JSON.stringify(retired), /该结果已过期/, 'the card says the result is over')
  assert.deepEqual(callbackValues(retired), [], 'and offers nothing left to reply with')
})


test('a press before the medium has answered leaves the card alone', async () => {
  // The record is on disk, but this process has not read it yet. A press arriving in that
  // window knows nothing — and the one thing it must not do is retire a card that is still
  // valid, because that card is what the reader comes back to once the process can serve
  // it. It reports, and changes nothing.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.sessionQuery.exists('s_1', 5)
  first.agents.set('s_1', { status: 'idle', followup: () => {} })
  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)
  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The restart, with a medium that has not answered yet.
  const second = await scaffold({ resultNotify: 'idle' }, {
    stored, keepDurable: true, holdStorage: true,
  })
  const early = await clickCard(submit, { [answer]: '来早了' })
  assert.equal(early.toast.type, 'warning', 'the early press is refused')
  assert.equal(observed.patched.length, 0, 'and it does not touch the card')

  // The medium answers, the restore lands, and the same card works from here.
  const followed = []
  second.agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  second.releaseStorage()
  await sleep(80)

  const accepted = await clickCard(submit, { [answer]: '接着做' })
  assert.equal(accepted.toast.content, '已发送给 agent', 'the card was still there to use')
  await sleep(10)
  assert.equal(followed.length, 1, 'and the reply reached the session')
})


test('a notice answered before a restart is not offered again by it', async () => {
  // The rid is single use, and a single use that a restart undoes would be no use at all.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, { stored })
  first.sessionQuery.exists('s_1', 5)
  const followed = []
  first.agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)
  await clickCard(submit, { [answer]: '按第一轮来' })
  await sleep(10)
  assert.equal(followed.length, 1, 'the reply was taken')

  const second = await scaffold({ resultNotify: 'idle' }, { stored, keepDurable: true })
  second.sessionQuery.exists('s_1', 9)
  second.agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  await sleep(40)

  const replayed = await clickCard(submit, { [answer]: '再来一次' })
  assert.equal(replayed.toast.type, 'warning', 'the consumed rid does not come back')
  await sleep(10)
  assert.equal(followed.length, 1, 'and no second instruction reaches the session')
})


test('a notice is remembered even when storage arrives after the plugin does', async () => {
  // The storage service is provided inside another plugin's own activation, so it can
  // appear after this one has loaded. The store used to open only from the startup path,
  // and a notice delivered in that window was dropped in silence: no record, no log line,
  // and a promise discovered broken only at the next restart.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ resultNotify: 'idle' }, {
    stored,
    services: ['settings', 'webServer', 'sessionQuery'],
  })
  first.sessionQuery.exists('s_1', 5)
  first.agents.set('s_1', { status: 'idle', followup: () => {} })

  // Storage turns up now, after the plugin has installed and already tried to restore.
  first.compose('storageDomain')

  runTurn(first.listenerOf('session/event').handler, 's_1')
  await sleep(1100)
  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const [answer] = controlNames(card)

  // The restart proves it was written: nothing else could have put it there.
  const second = await scaffold({ resultNotify: 'idle' }, { stored, keepDurable: true })
  const followed = []
  second.agents.set('s_1', { status: 'idle', followup: (message) => { followed.push(message) } })
  await sleep(40)

  const response = await clickCard(submit, { [answer]: '接着做' })
  assert.equal(response.toast.content, '已发送给 agent', 'the notice survived the restart')
  await sleep(10)
  assert.equal(followed.length, 1, 'and carried the reply')
})


test('a deployment with no storage says so instead of failing quietly', async () => {
  // Silence is what made the earlier failure take a filesystem dig to find: a missing
  // service and a broken medium have to be tellable apart from the log alone.
  const { infos } = await scaffold({ resultNotify: 'idle' }, { services: ['settings', 'webServer'] })
  await sleep(30)

  assert.match(infos.join('\n'), /未装配持久存储服务/,
    `the deployment says the notices will not be kept: ${infos.join(' | ')}`)
})


