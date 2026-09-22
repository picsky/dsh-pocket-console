/**
 * Escalation timing, the desktop-first race, cancellation, disposal, and the pending report.
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
  SAME_ORIGIN,
  observed,
} from './support/harness.mjs'

test('the phone card follows the language the page reports', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  // What the browser half posts on every state report; the Host has no other way
  // to know which language the reader is reading in.
  const reported = await route('POST', '/__pocket/mirror', SAME_ORIGIN, { status: 'loaded', lang: 'en' })
  assert.equal(reported.status, 200)

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', reason: 'needs the workspace', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  assert.match(JSON.stringify(sentCard()), /Tool approval/, 'the card follows the page')

  desktop.resolve('rejected')
  assert.equal(await result, 'rejected')
})

test('only the bound recipient can answer a card', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)

  // The card is a capability, and the answer it carries becomes human input. A
  // press from anyone but the bound recipient must not become one.
  const allowed = callbackValues(sentCard()).find(value => value.v === 'allowed-once')
  const stranger = await clickCard(allowed, undefined, { operator: 'ou_someone_else' })
  assert.equal(stranger.toast.type, 'warning')
  assert.match(stranger.toast.content, /只有绑定的接收人/)

  const owner = await clickCard(allowed)
  assert.equal(owner.toast.type, 'success')
  assert.equal(await result, 'allowed-once', 'the stranger changed nothing')
})

test('escalates an approval to the bound user and answers it from the card', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  assert.equal(approval.options?.prepend, true, 'must prepend, or the Web forwarder never yields')

  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', reason: '需要越过工作区写沙箱', signal: new AbortController().signal },
    () => desktop.promise,
  )
  assert.equal(observed.created.length, 0, 'no card before the delay elapses')
  await sleep(1200)

  assert.equal(observed.created[0].params.receive_id_type, 'open_id')
  assert.equal(observed.created[0].data.receive_id, 'ou_scanner', 'the card goes to the bound user')

  const card = sentCard()
  assert.equal(card.schema, '2.0')
  assert.equal(card.config.update_multi, true, 'a shared card is required for the later rewrite')
  const buttons = callbackValues(card)
  assert.deepEqual(
    buttons.map(value => value.v).sort(),
    ['allowed-once', 'rejected'],
    'both outcomes must be reachable',
  )
  assert.match(JSON.stringify(card), /需要越过工作区写沙箱/)

  const rid = buttons[0].rid
  const toast = await clickCard({ rid, v: 'allowed-once' })
  assert.equal(toast.toast.type, 'success')
  assert.equal(await result, 'allowed-once', 'a phone answer must become the approval outcome')

  await sleep(20)
  assert.equal(observed.patched.length, 1, 'the card is rewritten once decided')
  assert.match(observed.patched[0].data.content, /已批准/)
})


test('a desktop answer wins and suppresses the card entirely', async () => {
  const { route, listenerOf } = await scaffold({ delaySeconds: 30 })
  await bind(route)
  const approval = listenerOf('approval/request')

  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected')
  await sleep(20)
  assert.equal(observed.created.length, 0, 'the desktop answer must not trigger a card')
})


test('an aborted request neither delivers nor settles', async () => {
  const { route, listenerOf } = await scaffold({ delaySeconds: 30 })
  await bind(route)
  const approval = listenerOf('approval/request')
  const controller = new AbortController()
  const desktop = Promise.withResolvers()

  const result = approval.handler({ toolName: 'pwsh', signal: controller.signal }, () => desktop.promise)
  controller.abort()
  await sleep(20)
  assert.equal(observed.created.length, 0, 'a withdrawn request must not reach the phone')

  desktop.resolve('cancelled')
  assert.equal(await result, 'cancelled')
})


test('disposal removes the route, stops the connection, and abandons escalations', async () => {
  const { route, routes, listenerOf, disposers } = await scaffold()
  await bind(route)
  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)

  for (const dispose of disposers) dispose()

  assert.equal(routes.length, 0, 'the route is removed with the plugin')
  assert.equal(observed.closed, 1, 'the long connection is closed')
  await sleep(50)
  assert.equal(observed.created.length, 0, 'an abandoned escalation must not deliver a card')
  desktop.resolve('unavailable')
})

test('disposal takes back the abort listener it put on the request', async () => {
  // Disposal used to clear each record's timer and drop its registry slot by hand, and leave the
  // listener it had added to the request's signal. A retired plugin then went on reacting to aborts,
  // and a signal that outlives many requests accumulated listeners until Node warned about it. Every
  // record holds three things — a timer, a slot, and that listener — and only one function in the
  // module knows all three, so disposal goes through it.
  const { route, listenerOf, disposers } = await scaffold()
  await bind(route)
  const controller = new AbortController()
  const desktop = Promise.withResolvers()

  let adds = 0
  let removes = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (...args) => { adds += 1; return add(...args) }
  controller.signal.removeEventListener = (...args) => { removes += 1; return remove(...args) }

  void listenerOf('approval/request').handler(
    { toolName: 'pwsh', signal: controller.signal },
    () => desktop.promise,
  )
  await sleep(20)
  assert.equal(adds, 1, 'the escalation listened for the request being withdrawn')

  for (const dispose of disposers) dispose()

  assert.equal(removes, 1, 'and disposal takes that listener back')
  desktop.resolve('unavailable')
})


test('reports what is still pending, and whether the phone already has it', async () => {
  const { route, state, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)

  const desktop = Promise.withResolvers()
  void listenerOf('user-questions/request').handler({
    questions: [{ id: 'q', header: '发布', question: '现在发布吗？', options: [{ label: '发布' }] }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  void listenerOf('approval/request').handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )

  const waiting = (await state()).pending
  assert.deepEqual(
    waiting.map(entry => [entry.kind, entry.summary]),
    [['question', '发布'], ['approval', 'pwsh']],
    'each open escalation names what it is, so the count is not a dead end',
  )
  assert.ok(
    waiting.every(entry => entry.delivered === false),
    'nothing has reached the phone before the desktop head start elapses',
  )

  await sleep(1200)
  assert.ok((await state()).pending.every(entry => entry.delivered === true))
  desktop.resolve({ answers: [] })
})

test('the card copy follows the deployment language', async () => {
  const { route, listenerOf } = await scaffold({ locale: 'en' })
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', reason: 'needs the workspace', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)

  // Every card string comes from the dictionary, so an English deployment reads
  // English — including the labels a person presses and the toast they get back.
  const card = sentCard()
  const rendered = JSON.stringify(card)
  assert.match(rendered, /Tool approval/)
  assert.match(rendered, /\*\*Reason\*\*: needs the workspace/)
  assert.match(rendered, /Allow once/)

  const settled = await clickCard(callbackValues(card).find(value => value.v === 'allowed-once'))
  assert.equal(settled.toast.content, 'Allowed once')
  assert.equal(await result, 'allowed-once')
})

test('a card names the workspace of the session it belongs to', async () => {
  const { route, listenerOf, agents } = await scaffold()
  await bind(route)
  const agent = { status: 'idle', session: { header: { cwd: '/work/my-app' } } }
  agents.set('s_ws', agent)

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler(
    { toolName: 'pwsh', agent, signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)

  const card = sentCard()
  assert.equal(card.header.title.content, 'DSH 工具审批 · my-app', 'the title names the workspace')
  desktop.resolve('rejected')
})

test('a request with no workspace to name still gets the title it always had', async () => {
  const { route, listenerOf, agents } = await scaffold()
  await bind(route)
  // A live agent whose session carries no working directory: real, and the case that
  // must not turn into a bare separator or an invented name on the card.
  const agent = { status: 'idle', session: { header: {} } }
  agents.set('s_bare', agent)

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler(
    { toolName: 'pwsh', agent, signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)

  assert.equal(sentCard().header.title.content, 'DSH 工具审批', 'the title is exactly what it was before')
  desktop.resolve('rejected')
})

test('a card carries its workspace rather than re-reading the session', async () => {
  const { route, listenerOf, agents } = await scaffold()
  await bind(route)
  const agent = { status: 'idle', session: { header: { cwd: '/work/my-app' } } }
  agents.set('s_ws', agent)

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler(
    { toolName: 'pwsh', agent, signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  assert.equal(sentCard().header.title.content, 'DSH 工具审批 · my-app', 'the card went out named')

  // The session is reclaimed before the reader answers — the case the design exists for.
  // A rewrite that looked the workspace up again would come back with nothing, and the
  // card would turn anonymous at the moment it is answered.
  agent.session.header = {}
  agents.delete('s_ws')
  const settled = await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
  assert.equal(settled.toast.content, '已批准（仅本次）')
  await sleep(20)

  const rewritten = JSON.parse(observed.patched.at(-1).data.content)
  assert.equal(
    rewritten.header.title.content,
    'DSH 工具审批 · my-app',
    'the settlement is named from what the card already knew, not from a session that is gone',
  )
})

test('a card rewritten once the request is answered keeps the workspace', async () => {
  const { route, listenerOf, agents } = await scaffold()
  await bind(route)
  const agent = { status: 'idle', session: { header: { cwd: '/work/my-app' } } }
  agents.set('s_ws', agent)

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler(
    { toolName: 'pwsh', agent, signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)

  const settled = await clickCard(callbackValues(sentCard()).find(value => value.v === 'allowed-once'))
  assert.equal(settled.toast.content, '已批准（仅本次）')
  await sleep(20)

  // The rewrite is the last thing the reader sees, so it has to agree with the card
  // it replaces — a title that loses the workspace here would make the card that was
  // just identified become anonymous again.
  const rewritten = JSON.parse(observed.patched.at(-1).data.content)
  assert.equal(rewritten.header.title.content, 'DSH 工具审批 · my-app', 'the settlement keeps the workspace')
})

test('a card the platform accepted but never answered is not sent again', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  // The failure a retry can make worse: the platform has the card, and this side never finds
  // out. Without an idempotency key the retry would deliver the reader a second card.
  observed.loseNextAnswer = true
  await sleep(6_400)
  assert.equal(observed.lostAnswers, 1, 'the first send was accepted and its answer was lost')
  assert.equal(observed.created.length, 1, 'so exactly one card exists')
  assert.equal(observed.deduplicated, 1, 'and the retry was answered, not sent')

  // The escalation is still live: the card can be answered from the phone.
  const card = sentCard()
  const allow = callbackValues(card).find(value => value.v === 'allowed-once')
  const toast = await clickCard(allow)
  assert.equal(toast.toast.type, 'success')
  assert.equal(await result, 'allowed-once', 'a phone answer still settles the request')
})

test('a transient refusal is retried, and the card arrives once under one key', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  observed.failNextDelivery = 'the platform is momentarily unavailable'
  await sleep(6_400)
  assert.equal(observed.deliveryFailures, 1, 'the first attempt was refused')
  assert.equal(observed.created.length, 1, 'and the retry arrived')
  assert.equal(typeof observed.created[0].data?.uuid, 'string', 'the card carries an idempotency key')

  const card = sentCard()
  const allow = callbackValues(card).find(value => value.v === 'allowed-once')
  const toast = await clickCard(allow)
  assert.equal(toast.toast.type, 'success')
  assert.equal(await result, 'allowed-once')
})

test('a card that keeps failing is given up on, and the desktop decides', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  observed.failEveryDelivery = true
  await sleep(16_200)
  assert.equal(observed.created.length, 0, 'no card ever landed')
  assert.equal(observed.createAttempts, 4, 'one card is worth four attempts')
  desktop.resolve('allowed-once')
  assert.equal(await result, 'allowed-once', 'the desktop answer still decides')
})

test('a settled card whose rewrite is refused is rewritten on the retry', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route, { openId: 'ou_scanner' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  const allow = callbackValues(sentCard()).find(value => value.v === 'allowed-once')

  // A rewrite that fails once leaves the card looking answerable — buttons on a decided
  // request. The retry lands within a second, so the card stops offering them.
  observed.failNextPatch = 'rate limited'
  const toast = await clickCard(allow)
  assert.equal(toast.toast.type, 'success')
  assert.equal(await result, 'allowed-once')
  await sleep(1_300)
  assert.equal(observed.patched.length, 1, 'the settled card was rewritten on the retry')
  assert.match(observed.patched[0].data.content, /已批准/, 'and carries the outcome')
})


