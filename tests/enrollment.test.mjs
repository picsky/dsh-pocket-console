/**
 * Enrollment reporting: what the card can tell about a connection, and when.
 *
 * A connection is only reported bound once the long connection says it is up,
 * a pair the platform rejects is reported in words instead of leaving the card
 * at "connecting", and the two ways to bind are told apart in the card.
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
  bind,
  observed,
  platform,
} from './support/harness.mjs'

/** Adopt the credentials the user typed, the way the card posts them. */
async function adopt(route, body) {
  return await route('POST', '/__pocket/adopt', SAME_ORIGIN, body)
}

test('an adopted app is reported connected only once the connection is up', async () => {
  const { route, json, state } = await scaffold()
  observed.handshake = 'held'

  const adopted = json(await adopt(route, { appId: 'cli_adopted', appSecret: 'secret_adopted' }))
  assert.equal(adopted.state, 'starting', 'passing the check is not the connection being up')
  assert.equal(observed.started, 1, 'and the handshake was launched')
  assert.deepEqual(
    platform.checks.map(check => check.appId),
    ['cli_adopted'],
    'the pair is checked against the platform before anything connects',
  )
  assert.match(platform.checks[0].url, /tenant_access_token\/internal$/)

  // The SDK's ready callback is the first moment this channel can receive.
  observed.wsClients[0].config.onReady()
  await sleep(10)
  const bound = await state()
  assert.equal(bound.enrollment.state, 'bound')
  assert.equal(bound.enrollment.appId, 'cli_adopted', 'the card can name the app it is bound to')
  assert.equal(bound.enrollment.connected, true)
})

test('a pair the platform rejects is reported in words and is not kept', async () => {
  const { route, json, state, values, infos } = await scaffold()
  platform.answer = { code: 10014, msg: 'app id not exists' }

  const refused = json(await adopt(route, { appId: 'cli_missing', appSecret: 'secret_typo' }))
  assert.equal(refused.state, 'failed')
  assert.equal(refused.message, 'App ID 不存在，请确认它与开发者后台里显示的一致')
  assert.equal(observed.started, 0, 'no handshake is attempted with a pair the platform refused')
  assert.equal(values.size, 0, 'a rejected pair is not kept for the next boot')
  assert.equal((await state()).enrollment.message, refused.message, 'and the card keeps reading it')
  assert.ok(
    !infos.join('\n').includes('secret_typo'),
    'the secret is checked and stored, never logged',
  )
})

test('an unreachable platform is reported without discarding what was typed', async () => {
  const { route, json, values } = await scaffold()
  platform.failure = 'fetch failed'

  const failed = json(await adopt(route, { appId: 'cli_offline', appSecret: 'secret_offline' }))
  assert.equal(failed.state, 'failed')
  assert.equal(failed.message, 'fetch failed', 'the reason is the one the network gave')
  assert.equal(values.get('DSH_FEISHU_APP_ID'), 'cli_offline', 'what could not be checked is kept')
})

test('adopting another app replaces the live connection instead of leaving it running', async () => {
  const { route, json, state } = await scaffold({}, {
    stored: { appId: 'cli_first', appSecret: 'secret_first', recipient: 'ou_first' },
  })
  assert.equal(observed.started, 1, 'the stored app connects at load')

  const adopted = json(await adopt(route, { appId: 'cli_second', appSecret: 'secret_second' }))
  assert.equal(adopted.state, 'starting')
  assert.equal(observed.closed, 1, 'the connection that belonged to the previous pair is closed')
  assert.equal(observed.started, 2)
  await sleep(10)
  const bound = await state()
  assert.equal(bound.enrollment.state, 'bound')
  assert.equal(bound.enrollment.appId, 'cli_second', 'and the card names the new app')
})

test('adopting clears a verification link the card was still offering', async () => {
  const { route, json, state } = await scaffold()
  await requestBinding(route)
  assert.equal((await state()).enrollment.state, 'awaiting')
  observed.handshake = 'held'

  const adopted = json(await adopt(route, { appId: 'cli_typed', appSecret: 'secret_typed' }))
  assert.equal(adopted.state, 'starting')
  assert.equal(adopted.verifyUrl, undefined, 'the link belonged to the attempt that was replaced')
  assert.equal((await state()).enrollment.verifyUrl, undefined, 'and the card stops rendering a QR')
})

test('a store that refuses the pair still connects with what was typed, and says so', async () => {
  const { route, json, state, values } = await scaffold({}, { refuseWrites: true })

  const adopted = json(await adopt(route, { appId: 'cli_typed', appSecret: 'secret_typed' }))
  assert.equal(adopted.state, 'starting')
  assert.equal(values.size, 0, 'nothing was written')
  assert.equal(observed.started, 1)
  await sleep(10)
  const bound = await state()
  assert.equal(bound.enrollment.state, 'bound', 'the typed pair is what connects')
  assert.equal(bound.enrollment.appId, 'cli_typed')
  assert.equal(bound.enrollment.persisted, false, 'and the card is told it could not be kept')
  assert.match(bound.enrollment.persistError, /shadows/)
})

test('a handshake that fails terminally is reported as a failure', async () => {
  const { route, json, state, warnings } = await scaffold()
  observed.handshake = 'failed'
  observed.handshakeError = 'code: 1000040343'

  const failed = json(await adopt(route, { appId: 'cli_broken', appSecret: 'secret_broken' }))
  assert.equal(failed.state, 'failed')
  assert.match(failed.message, /1000040343/)
  assert.ok(warnings.length > 0, 'the deployment log carries the failure')

  // A slow notice armed for an attempt that already ended must not overwrite the
  // failure it replaced.
  await sleep(20)
  assert.equal((await state()).enrollment.state, 'failed')
})

test('a direct message re-binds the recipient the card is showing', async () => {
  const { route, json, state } = await scaffold()
  await bind(route, { openId: 'ou_first' })
  assert.equal((await state()).enrollment.recipient, 'ou_first')

  await directMessage('ou_second')
  assert.equal(
    (await state()).enrollment.recipient,
    'ou_second',
    'the card stops asking for a message the user has just sent',
  )
})
