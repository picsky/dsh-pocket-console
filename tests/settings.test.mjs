/**
 * Settings namespace, same-origin routes, load-order tolerance, and runtime changes.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sleep,
  scaffold,
  bind,
  observed,
  SAME_ORIGIN,
} from './support/harness.mjs'

test('the connection trust fence guards every route', async () => {
  const { route, setRejection } = await scaffold({}, {
    services: ['settings', 'webServer', 'connection'],
  })
  assert.equal((await route('GET', '/__pocket/state')).status, 200, 'a trusted browser reads the state')

  setRejection(401)
  const refused = await route('GET', '/__pocket/state')
  assert.equal(refused.status, 401, 'an untrusted caller gets the connection 401')
  assert.deepEqual(JSON.parse(refused.body), { error: 'unauthorized' })
  assert.equal(
    (await route('POST', '/__pocket/unbind', SAME_ORIGIN)).status,
    401,
    'and it cannot mutate either',
  )
})

test('mirror reports ride the state route without filling the log', async () => {
  const { route, state, infos, debugs } = await scaffold()

  const accepted = await route('POST', '/__pocket/mirror', SAME_ORIGIN)
  assert.equal(accepted.status, 200, 'the browser half can always report')

  const snapshot = await state()
  assert.equal(snapshot.mirror.length, 1, 'the report is on the state route')
  assert.equal(snapshot.mirror[0].status, 'unknown', 'an empty report is still recorded')
  assert.equal(snapshot.settings.mirrorTtlSeconds, 60, 'the mirror window is served as a setting')
  assert.ok(!infos.some(line => line.includes('桌面镜像')), 'a page load must not fill the deployment log')
  assert.ok(debugs.some(line => line.includes('桌面镜像')), 'and it stays available when the logger is asked')
})

test('registers a settings namespace and the same-origin route', async () => {
  const { sections, routes } = await scaffold()
  assert.deepEqual([...sections.keys()], ['pocket-console'], 'the card is keyed by the namespace')
  assert.equal(sections.get('pocket-console').entry.delaySeconds, 1)
  assert.equal(routes.length, 1)
  assert.deepEqual(
    { kind: routes[0].kind, path: routes[0].path },
    { kind: 'prefix', path: '/__pocket' },
  )
})


test('a deployment with neither a webserver nor a settings provider still loads', async () => {
  const { infos, routes, sections, listenerOf } = await scaffold({}, { services: [] })

  assert.equal(routes.length, 0, 'there is no server to answer the card from')
  assert.equal(sections.size, 0, 'there is no provider to hold the section')
  assert.ok(
    infos.some(line => line.includes('webServer is absent')),
    'the log is the only surface such a deployment has',
  )
  assert.equal(observed.registerAppCalls.length, 1, 'onboarding starts without waiting for a card')

  const desktop = Promise.withResolvers()
  const result = listenerOf('approval/request').handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected', 'the answerers still run')
})


test('a service composed after load still receives the section and the routes', async () => {
  const { sections, routes, compose } = await scaffold({}, { services: [] })
  assert.equal(sections.size, 0)
  assert.equal(routes.length, 0)

  compose('settings')
  compose('webServer')

  assert.ok(sections.has('pocket-console'), 'the section follows the provider, not the load order')
  assert.equal(routes.length, 1, 'the routes follow the server')
})


test('refuses a cross-origin mutation', async () => {
  const { route, json } = await scaffold()
  const refused = await route('POST', '/__pocket/bind', { origin: 'http://evil.example' })
  assert.equal(refused.status, 403)
  assert.equal(json(refused).error, 'cross-origin request refused')
  assert.equal(observed.registerAppCalls.length, 0, 'a refused request must not start onboarding')
})

test('a body the caller got wrong is a 400, not a server fault', async () => {
  const { route, json } = await scaffold()

  // Not JSON at all.
  const malformed = await route('POST', '/__pocket/bind', SAME_ORIGIN, 'not json {')
  assert.equal(malformed.status, 400, "a malformed body is the caller's mistake")
  assert.equal(json(malformed).error, 'body is not JSON')

  // Past the route's own limit, sent verbatim: serialising it would produce valid
  // JSON, and the size check is the thing under test.
  const oversized = await route('POST', '/__pocket/bind', SAME_ORIGIN, `"${'x'.repeat(70 * 1024)}"`)
  assert.equal(oversized.status, 400, 'an oversized body is refused as a bad request')
  assert.equal(json(oversized).error, 'body too large')

  assert.equal(observed.registerAppCalls.length, 0, 'neither attempt started onboarding')
})


test('a settings change takes effect without a restart', async () => {
  const { route, state, sections, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)

  // A card write lands in the provider's user layer, which then reports a change.
  // Nothing hands the source over again, so a plugin that kept its install-time
  // value would keep the old delay — and keep it until a restart.
  const section = sections.get('pocket-console')
  section.change(layer => { layer.delaySeconds = 600; layer.titlePrefix = 'Re' })

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)
  await sleep(300)
  assert.equal(observed.created.length, 0, 'the raised delay must suppress delivery')
  desktop.resolve('rejected')

  const snapshot = await state()
  assert.equal(snapshot.settings.delaySeconds, 600)
  assert.equal(snapshot.settings.titlePrefix, 'Re')
})

test('a later settings change replaces the one before it', async () => {
  const { state, sections } = await scaffold({ delaySeconds: 1 })
  const section = sections.get('pocket-console')

  section.change(layer => { layer.delaySeconds = 5 })
  assert.equal((await state()).settings.delaySeconds, 5, 'the first edit is read back')

  section.change(layer => { layer.delaySeconds = 9 })
  assert.equal((await state()).settings.delaySeconds, 9, 'and so is the second, without a source handed over again')

  // Clearing the override returns the field to what the deployment composed.
  section.change(layer => { delete layer.delaySeconds })
  assert.equal((await state()).settings.delaySeconds, 1, 'and a cleared field falls back to the composition entry')
})


test('shortening the wait releases a request that was already counting it down', async () => {
  const { route, sections, listenerOf } = await scaffold({ delaySeconds: 600 })
  await bind(route)
  const section = sections.get('pocket-console')
  const approval = listenerOf('approval/request')

  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)

  // The wait is measured from the request's arrival, so what matters here is only
  // that the new value is shorter than the time still to run — which is the case
  // the reader meets as "the setting did not save". Under the 600 seconds in force
  // nothing would go out for ten minutes.
  section.change(layer => { layer.delaySeconds = 1 })
  await sleep(1400)
  assert.equal(observed.created.length, 1, 'the card goes out under the value now in force')

  // A request that arrives under the short wait is untouched: the edit re-times a
  // countdown, it does not deliver everything that is pending on principle.
  desktop.resolve('rejected')
  const later = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => later.promise)
  await sleep(1400)
  assert.equal(observed.created.length, 2, 'and a request raised afterwards uses the same value')
  later.resolve('rejected')
})

test('lengthening the wait defers a request that has not gone out yet', async () => {
  const { route, sections, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)
  const section = sections.get('pocket-console')
  const approval = listenerOf('approval/request')

  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)
  // The 1 second in force when the request arrived would have sent it by now; the
  // longer wait is the one that holds it.
  section.change(layer => { layer.delaySeconds = 600 })
  await sleep(1400)
  assert.equal(observed.created.length, 0, 'the longer wait is the one that holds it')
  desktop.resolve('rejected')
})

test('shortening the wait releases a notice that was already inside its window', async () => {
  const { route, sections, listenerOf, agents } = await scaffold({
    delaySeconds: 600,
    resultNotify: 'idle',
  })
  await bind(route)
  const section = sections.get('pocket-console')
  const emit = listenerOf('session/event').handler
  agents.set('s_1', { status: 'idle', followup: () => {} })

  // A turn that stops: the calm window is armed from the 600 seconds in force.
  emit({ id: 's_1' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  emit({ id: 's_1' }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id: 's_1' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: '已经改好了。' }] } },
  })
  emit({ id: 's_1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(50)
  assert.equal(observed.created.length, 0, 'nothing is sent while 600 seconds are outstanding')

  section.change(layer => { layer.delaySeconds = 1 })
  await sleep(1400)
  assert.equal(observed.created.length, 1, 'the notice follows the value now in force, not the one it was armed with')
})

