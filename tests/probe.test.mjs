/**
 * The channel's liveness probe: while a connection is up, the channel asks the
 * platform whether it still accepts this app. A refusal takes the channel down
 * (so `available()` turns false and nothing is escalated into a dead channel);
 * an unreachable platform proves nothing and is left alone.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { sleep, scaffold, bind, observed } from './support/harness.mjs'

test('a probe finding the app rejected takes the connection down and says why', async () => {
  const { state, route } = await scaffold({ channelConfig: { probeIntervalMs: 40 } })
  await bind(route, { openId: 'ou_scanner' })

  // The platform stops accepting this app's pair mid-run: the next probe reports it, the long
  // connection is closed, and the settings card says why instead of claiming to be up.
  observed.tenantToken = { code: 10014, msg: 'app id not exists' }
  await sleep(150)

  const enrollment = (await state()).enrollment
  assert.equal(enrollment.state, 'failed', 'the card says the channel failed')
  assert.equal(observed.closed, 1, 'and the long connection was closed')
})

test('a probe the platform cannot reach leaves the connection alone', async () => {
  const { state, route } = await scaffold({ channelConfig: { probeIntervalMs: 40 } })
  await bind(route, { openId: 'ou_scanner' })
  const closedBefore = observed.closed

  // Unreachability proves nothing about the credentials, so it must not flap the card.
  observed.tenantToken = { throws: 'network unreachable' }
  await sleep(150)

  assert.equal(observed.closed, closedBefore, 'a network miss does not close the connection')
  assert.equal((await state()).enrollment.state, 'bound', 'and the card still says connected')
})

test('a dead channel escalates nothing until it is reconnected', async () => {
  const { state, route, listenerOf } = await scaffold({ channelConfig: { probeIntervalMs: 40 } })
  await bind(route, { openId: 'ou_scanner' })

  observed.tenantToken = { code: 10014, msg: 'app id not exists' }
  await sleep(150)
  assert.equal((await state()).enrollment.state, 'failed')

  // The return path is down, so a request must stay on the desktop rather than being
  // offered a card that can never be answered.
  const approval = listenerOf('approval/request')
  const desktop = Promise.withResolvers()
  const result = approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  await sleep(30)
  assert.equal(observed.created.length, 0, 'nothing is sent to a dead channel')
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected', 'the desktop answer still decides')
})
