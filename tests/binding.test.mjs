/**
 * Binding lifecycle: unbound → awaiting → bound, QR, unbind, re-binding, failure degradation.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sleep,
  SAME_ORIGIN,
  directMessage,
  scaffold,
  requestBinding,
  scan,
  bind,
  observed,
} from './support/harness.mjs'

test('reports unbound state and does not escalate before binding', async () => {
  const { state, listenerOf, infos } = await scaffold()

  const snapshot = await state()
  assert.equal(snapshot.namespace, 'pocket-console')
  assert.deepEqual(snapshot.pending, [], 'nothing is open before a request arrives')
  assert.equal(snapshot.enrollment.state, 'unbound')
  assert.equal(observed.registerAppCalls.length, 0, 'nothing starts until the card asks')

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  assert.equal(observed.created.length, 0, 'an unbound channel must not deliver')
  assert.equal(infos.length, 0, 'and it must not log a link the user never asked for')
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected')
})

test('an existing app is adopted by its credentials, with no scan at all', async () => {
  const { route, json, values, infos, state } = await scaffold()

  // Binding a bot the user already has is exactly this: the credentials it is
  // named by. No device authorization, no launch page, no polling — and the
  // one-click flow is never called, so nothing is created or modified in Feishu.
  const adopted = json(await route('POST', '/__pocket/adopt', SAME_ORIGIN, {
    appId: 'cli_existing',
    appSecret: 'secret_from_console',
  }))
  assert.equal(observed.registerAppCalls.length, 0, 'and never runs the create flow')
  assert.equal(observed.started, 1, 'the long connection is launched')
  // The connection reports itself ready out of band, so the answer to the click
  // says the attempt is running and the card reads the verdict from its poll.
  assert.equal(adopted.state, 'starting')
  await sleep(10)
  assert.equal((await state()).enrollment.state, 'bound', 'the channel connects with what was entered')
  assert.equal(values.get('DSH_FEISHU_APP_ID'), 'cli_existing', 'the id is stored where the channel reads it')
  assert.equal(values.get('DSH_FEISHU_APP_SECRET'), 'secret_from_console')
  assert.ok(
    !infos.join('\n').includes('secret_from_console'),
    'a secret is stored, never written to the deployment log',
  )

  // A half-filled form is refused where it is made, not deeper in the connection.
  const refused = await route('POST', '/__pocket/adopt', SAME_ORIGIN, { appId: 'cli_existing' })
  assert.equal(refused.status, 400)
})

test('a restart reconnects from stored credentials without onboarding', async () => {
  const { state, listenerOf, infos } = await scaffold({}, {
    stored: { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' },
  })

  // Loading the plugin is the whole restart: the long connection comes back
  // from what an earlier run persisted, and nothing offers a scan.
  assert.equal(observed.started, 1, 'the long connection is back')
  assert.equal(observed.registerAppCalls.length, 0, 'a restart must not start onboarding')
  assert.ok(!infos.some(line => line.includes('请在手机上打开')), 'and must not print a link')

  const snapshot = await state()
  assert.deepEqual(snapshot.enrollment, {
    state: 'bound',
    appId: 'cli_stored',
    recipient: 'ou_stored',
    connected: true,
  })

  // The restored recipient is where an escalation goes, with no further action.
  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(1200)
  assert.equal(observed.created.length, 1, 'the card reaches the phone after a restart')
  assert.equal(observed.created[0].data.receive_id, 'ou_stored')
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected')
})


test('binding walks unbound to awaiting to bound and exposes a QR', async () => {
  const { route, state } = await scaffold()

  await requestBinding(route)
  const awaiting = await state()
  assert.equal(awaiting.enrollment.state, 'awaiting')
  assert.match(awaiting.enrollment.verifyUrl, /user_code=TEST-CODE/)
  assert.equal(observed.started, 0, 'no long connection before the scan completes')

  const qr = await route('GET', '/__pocket/qr.svg')
  assert.equal(qr.status, 200)
  assert.match(qr.headers['content-type'], /image\/svg\+xml/)
  assert.match(qr.body, /user_code=TEST-CODE/)

  await scan({ openId: 'ou_scanner' })
  const bound = await state()
  assert.equal(bound.enrollment.state, 'bound')
  assert.equal(bound.enrollment.recipient, 'ou_scanner')
  assert.equal(observed.started, 1, 'the long connection starts once credentials exist')
})


test('serves no QR before a binding is requested, and unbinds cleanly', async () => {
  const { route, json, values, records, state } = await scaffold()

  const missing = await route('GET', '/__pocket/qr.svg')
  assert.equal(missing.status, 404, 'no code exists before onboarding starts')

  await bind(route, { openId: 'ou_scanner' })
  assert.equal(values.get('DSH_FEISHU_APP_ID'), 'cli_test')
  assert.ok(records.has('pocket-console/recipient'))

  const cleared = json(await route('POST', '/__pocket/unbind', SAME_ORIGIN))
  assert.equal(cleared.state, 'unbound')
  assert.equal(values.size, 0, 'credentials are removed')
  assert.equal(records.size, 0, 'the binding is removed')
  assert.equal(observed.closed, 1, 'the long connection is closed')
  assert.equal((await state()).enrollment.state, 'unbound')
})


test('a one-click run that outlives an unbind writes nothing back', async () => {
  const { route, state, records } = await scaffold()
  await requestBinding(route)

  const unbound = await route('POST', '/__pocket/unbind', SAME_ORIGIN)
  assert.equal(unbound.status, 200)
  assert.equal(records.size, 0, 'unbinding clears the credentials and the recipient')

  // The device-authorization poll outlives the request that started it, so a
  // scan can settle after the user gave up on it.
  await scan()
  assert.equal(records.size, 0, 'a late scan must not re-create what the unbind removed')
  assert.equal((await state()).enrollment.state, 'unbound')
})


test('a bound deployment keeps its recipient when another account writes in', async () => {
  const { route, records, warnings } = await scaffold()
  await bind(route, { openId: 'ou_first' })

  // The recipient decides where approval cards go and whose presses are
  // honoured, so it is not a value any account that can reach the bot may take
  // over: a direct message binds an unbound deployment, and changes to a bound
  // one are the Settings card's business.
  await directMessage('ou_second')
  assert.deepEqual(records.get('pocket-console/recipient').payload, { id: 'ou_first' })
  assert.ok(warnings.some(error => String(error?.message ?? error).includes('忽略其他账号的私聊')))
})


test('a failed onboarding degrades to desktop-only instead of breaking startup', async () => {
  const { route, state, listenerOf, warnings, disposers } = await scaffold()
  await requestBinding(route)
  observed.failRegisterApp(Object.assign(new Error('denied'), { code: 'access_denied' }))
  await sleep(20)

  assert.ok(warnings.length > 0, 'the failure must be reported')
  assert.equal((await state()).enrollment.state, 'failed')

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('allowed-once')
  assert.equal(await result, 'allowed-once', 'the desktop chain stays authoritative')
  for (const dispose of disposers) dispose()
})

