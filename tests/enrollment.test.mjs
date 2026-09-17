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
import { LoggerLevel } from '@larksuiteoapi/node-sdk'
import {
  sleep,
  SAME_ORIGIN,
  directMessage,
  scaffold,
  requestBinding,
  bind,
  observed,
} from './support/harness.mjs'

/** Adopt the credentials the user typed, the way the card posts them. */
async function adopt(route, body) {
  return await route('POST', '/__pocket/adopt', SAME_ORIGIN, body)
}

/**
 * Deliver one raw event envelope, for the cases that are about the envelope
 * itself rather than about a click the harness already models.
 * @param event - the envelope's `event` body.
 */
async function clickEnvelope(event) {
  return await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event,
  })
}

test('an adopted app is reported connected only once the connection is up', async () => {
  const { route, json, state } = await scaffold()
  observed.handshake = 'held'

  const adopted = json(await adopt(route, { appId: 'cli_adopted', appSecret: 'secret_adopted' }))
  assert.equal(adopted.state, 'starting', 'passing the check is not the connection being up')
  assert.equal(adopted.stage, 'connecting', 'and the wait it reports is a connection, not a scan')
  assert.equal(observed.started, 1, 'and the handshake was launched')
  assert.equal(observed.requests.length, 1, 'the pair is checked against the platform before anything connects')
  // The SDK owns the origin behind its domain enum, so the check must ask with a
  // path: building one from the enum produced `0/open-apis/…` once already.
  assert.equal(observed.requests[0].url, '/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(observed.requests[0].data.app_id, 'cli_adopted')

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
  // The SDK refuses a bad pair by throwing, and its message carries the platform's
  // own answer — the shape observed against the live platform.
  observed.tenantToken = { throws: 'failed to get tenant_access_token, code: 10014, msg: app id not exists' }

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

test('a rejection the platform answers in a body is reported the same way', async () => {
  const { route, json, values } = await scaffold()
  // A code this build does not map keeps the platform's wording, which is enough
  // to name the half that is wrong.
  observed.tenantToken = { code: 12345, msg: 'app secret invalid' }

  const refused = json(await adopt(route, { appId: 'cli_body', appSecret: 'secret_wrong' }))
  assert.equal(refused.state, 'failed')
  assert.equal(refused.message, 'App Secret 不正确，请在开发者后台的「凭证与基础信息」里重新复制')
  assert.equal(values.size, 0, 'and that pair is not kept either')
})

test('an unreachable platform is reported without discarding what was typed', async () => {
  const { route, json, values } = await scaffold()
  observed.tenantToken = { throws: 'getaddrinfo ENOTFOUND open.feishu.cn' }

  const failed = json(await adopt(route, { appId: 'cli_offline', appSecret: 'secret_offline' }))
  assert.equal(failed.state, 'failed')
  assert.match(failed.message, /无法确认这组凭据/, 'the message claims no more than it knows')
  assert.match(failed.message, /ENOTFOUND/, 'and keeps the reason the network gave')
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

test('a terminal handshake failure leaves a retry that actually retries', async () => {
  // The card offers the way to bind again after a failure. That offer is only real if
  // the failed attempt gave its connection up: the channel reports `failed`, and if it
  // still held the dead transport then "try again" would return the same failure
  // without connecting — a button that looks live and is not.
  const { route, json, state } = await scaffold()
  observed.handshake = 'failed'
  observed.handshakeError = 'code: 1000040343'

  const failed = json(await adopt(route, { appId: 'cli_broken', appSecret: 'secret_broken' }))
  assert.equal(failed.state, 'failed')
  assert.equal(observed.started, 1)

  // A platform that answers this time: the retry has to reach it.
  observed.handshake = 'ready'
  const retry = json(await route('POST', '/__pocket/bind', SAME_ORIGIN))
  await sleep(30)

  assert.equal(
    observed.started,
    2,
    'the retry opens a new connection instead of returning the failure it replaced',
  )
  assert.equal((await state()).enrollment.state, 'bound', 'and the retry can succeed')
  assert.ok(retry.state === 'starting' || retry.state === 'bound', `the click reports work: ${retry.state}`)
})

test('a click on the scan names the wait it started, and never a second connection', async () => {
  const { route, json } = await scaffold({}, {
    stored: { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' },
  })
  // This deployment is already connected, which is the work the click would ask
  // for: it reports that instead of opening a second connection to the same app.
  const asked = json(await route('POST', '/__pocket/bind', SAME_ORIGIN))
  assert.equal(asked.state, 'bound')
  assert.equal(observed.registerAppCalls.length, 0, 'and the one-click flow is not run')
  assert.equal(observed.started, 1, 'and no second connection is opened')
})

test('a retry after a failed check reports the connection it is starting', async () => {
  const { route, json } = await scaffold({}, {
    stored: { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' },
    // The pair is kept, because a platform that could not be reached proved nothing
    // about it — so the retry connects with it rather than scanning for a new app.
    tenantToken: { throws: 'getaddrinfo ENOTFOUND open.feishu.cn' },
  })
  observed.tenantToken = {}

  const retry = json(await route('POST', '/__pocket/bind', SAME_ORIGIN))
  // The click answers before the run's first await resolves — that is the point:
  // the card must show the work it started, not the state it replaced.
  assert.equal(retry.state, 'starting')
  assert.equal(retry.stage, 'connecting', 'not a scan, because there is nothing to create')
  assert.equal(observed.registerAppCalls.length, 0, 'and the one-click flow is not run')
  // The run itself is claimed synchronously, so the store read and the connection
  // follow on their own turn rather than inside the click's own answer.
  await sleep(20)
  assert.equal(observed.started, 1, 'and exactly one connection is opened')
})

test('the SDK log goes to the deployment log at the deployment levels', async () => {
  const { route, json, infos, warnings, debugs } = await scaffold()
  observed.handshake = 'held'
  json(await adopt(route, { appId: 'cli_logged', appSecret: 'secret_logged' }))

  // Both clients take the plugin's logger, so nothing the SDK prints reaches the
  // terminal behind the deployment's back.
  const wsOptions = observed.wsClients[0].config
  assert.equal(wsOptions.loggerLevel, LoggerLevel.debug, 'every level is routed, and the levels decide')
  assert.equal(typeof wsOptions.logger?.info, 'function')
  for (const level of ['error', 'warn', 'info', 'debug', 'trace']) {
    assert.equal(typeof wsOptions.logger[level], 'function', `the SDK's ${level} has a route`)
  }
  assert.equal(
    observed.dispatcherOptions.loggerLevel,
    LoggerLevel.debug,
    'and the event dispatcher, which logs its own ready line, takes the same routing',
  )
  assert.equal(observed.dispatcherOptions.logger, wsOptions.logger, 'one adapter, so the routing cannot drift')

  // The banner and the connection chatter are info; errors and warnings are not.
  wsOptions.logger.info('[ws]', 'receive events or callbacks through persistent connection\n   only available in self-build & Feishu app')
  wsOptions.logger.error('[ws]', 'code: 1000040343, internal error')

  assert.ok(
    debugs.some(line => line.includes('receive events or callbacks through persistent connection')),
    'an info line lands in debug, where a deployment can ask for it',
  )
  assert.ok(
    !infos.some(line => line.includes('persistent connection')),
    'and never in the log a deployment reads by default',
  )
  assert.ok(
    warnings.some(line => String(line).includes('1000040343')),
    'while an error is reported',
  )
  assert.ok(
    debugs.every(line => !line.includes('1000040343')),
    'and an error is not demoted to debug',
  )
})

test('a direct message from a bound deployment does not hand the recipient to a stranger', async () => {
  const { route, state, warnings } = await scaffold()
  await bind(route, { openId: 'ou_first' })
  assert.equal((await state()).enrollment.recipient, 'ou_first')

  // The card is a capability: whoever holds a delivered card can press its
  // buttons, and a press becomes human-attributed input. The recipient is
  // therefore not something any account that can reach the bot may take over.
  await directMessage('ou_stranger')
  assert.equal(
    (await state()).enrollment.recipient,
    'ou_first',
    'a stranger who can message the bot does not become the recipient',
  )
  assert.ok(
    warnings.some(error => String(error?.message ?? error).includes('忽略其他账号的私聊')),
    `and the refusal is logged rather than silent: ${warnings.map(error => String(error?.message ?? error)).join(' | ')}`,
  )

  // The same account is still itself, so its own messages stay idempotent.
  await directMessage('ou_first')
  assert.equal((await state()).enrollment.recipient, 'ou_first')
})

test('a direct message binds an unbound deployment', async () => {
  const { route, state } = await scaffold()
  // A direct message only means anything to a deployment that is reachable at
  // all, and the dispatcher that carries it belongs to a connection.
  await adopt(route, { appId: 'cli_owner', appSecret: 'secret_owner' })
  assert.equal((await state()).enrollment.recipient, null, 'adopting an app leaves no recipient')

  await directMessage('ou_owner')
  assert.equal((await state()).enrollment.recipient, 'ou_owner', 'the first direct message binds')
})

test('a group message never binds an unbound deployment', async () => {
  const { route, state } = await scaffold()
  await adopt(route, { appId: 'cli_group', appSecret: 'secret_group' })
  assert.equal((await state()).enrollment.recipient, null)

  // An adopted app can carry any scopes its console has, so a group message can
  // arrive here. A sender in a group has not identified themselves as this
  // deployment's operator, so it must not become the recipient.
  await clickEnvelope({
    message: { chat_type: 'group' },
    sender: { sender_id: { open_id: 'ou_group_member' } },
  })
  assert.equal((await state()).enrollment.recipient, null, 'a group sender is not the recipient')
})
