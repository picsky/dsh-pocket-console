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

test('the launch page is aimed at an existing app by naming it', async () => {
  const { route, state } = await scaffold()

  // The landing page learns which app to update from `clientID`, which only
  // `appId` sets: `createOnly: false` alone is dropped by the SDK, so an
  // app-less request still lands on the create flow.
  await route('POST', '/__pocket/bind', SAME_ORIGIN, {})
  assert.equal(observed.registerAppCalls.at(-1).createOnly, true, 'the default creates')
  assert.equal(observed.registerAppCalls.at(-1).appId, undefined, 'and names no app')
  await scan({ openId: 'ou_scanner' })

  await route('POST', '/__pocket/unbind', SAME_ORIGIN)
  await route('POST', '/__pocket/bind', SAME_ORIGIN, { mode: 'existing' })
  assert.equal(
    observed.registerAppCalls.at(-1).appId,
    undefined,
    'binding an existing app without naming one has nothing to bind',
  )

  // A request that differs from the run already in flight starts its own, or the
  // promise in hand would keep polling for a scan nobody is going to do.
  await route('POST', '/__pocket/bind', SAME_ORIGIN, { mode: 'existing', appId: 'cli_existing' })
  assert.equal(observed.registerAppCalls.at(-1).appId, 'cli_existing')
  assert.equal(observed.registerAppCalls.at(-1).createOnly, false, 'which keeps clientID in play')

  await scan({ openId: 'ou_scanner' })
  assert.equal((await state()).enrollment.state, 'bound')
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
  assert.deepEqual(snapshot.enrollment, { state: 'bound', recipient: 'ou_stored' })

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


test('re-binding follows a direct message from a new account', async () => {
  const { route, records } = await scaffold()
  await bind(route, { openId: 'ou_first' })
  await directMessage('ou_second')
  assert.deepEqual(records.get('pocket-console/recipient').payload, { id: 'ou_second' })
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

