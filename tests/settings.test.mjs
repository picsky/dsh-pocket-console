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
} from './support/harness.mjs'

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


test('a settings change takes effect without a restart', async () => {
  const { route, state, sections, listenerOf } = await scaffold({ delaySeconds: 1 })
  await bind(route)

  // The card's namespace is the override path: a committed change re-sources.
  const section = sections.get('pocket-console')
  section.hooks.setSource(() => ({ delaySeconds: 600, maxDetailChars: 1200, titlePrefix: 'Re' }))
  section.hooks.onChange()

  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  void approval.handler({ toolName: 'pwsh', signal: new AbortController().signal }, () => desktop.promise)
  await sleep(300)
  assert.equal(observed.created.length, 0, 'the raised delay must suppress delivery')
  desktop.resolve('rejected')

  const snapshot = await state()
  assert.equal(snapshot.settings.delaySeconds, 600)
})

