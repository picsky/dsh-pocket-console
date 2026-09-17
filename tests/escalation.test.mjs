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
  observed,
} from './support/harness.mjs'

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


