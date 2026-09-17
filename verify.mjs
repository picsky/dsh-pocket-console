/**
 * Local logic verification for dsh-pocket-console with stubbed Feishu and QR
 * libraries: settings registration, the same-origin routes, onboarding before
 * and after the scan, escalation timing, callback decoding, the desktop-first
 * race, abort handling, and disposal.
 *
 * Run: node verify.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { observed, resetObserved } from '@larksuiteoapi/node-sdk'
import * as Plugin from './index.js'

const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) })

const HOST = '127.0.0.1:3080'
const SAME_ORIGIN = { origin: `http://${HOST}` }

/**
 * Click one button the way the long connection delivers it: through the
 * dispatcher, inside the v2 envelope whose `event` the SDK flattens before the
 * handler sees it.
 * @param value - the clicked button's payload.
 * @param formValue - submitted form values, keyed by input name.
 * @returns the channel's response, whose toast reports the outcome.
 */
async function clickCard(value, formValue) {
  return await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      action: { value, ...(formValue === undefined ? {} : { form_value: formValue }) },
      context: { open_message_id: 'om_stub_1' },
    },
  })
}

/**
 * Send one direct message, which is how a changed account re-binds.
 * @param openId - the sender's open id.
 * @returns the handler's return value.
 */
async function directMessage(openId) {
  return await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: { sender: { sender_id: { open_id: openId } } },
  })
}

/** One HTTP request shaped as the webserver hands it to a route handler. */
function makeRequest(method, path, headers = {}) {
  return {
    method,
    url: path,
    headers: { host: HOST, ...headers },
    async *[Symbol.asyncIterator]() {},
  }
}

/** One HTTP response recorder. */
function makeResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
    },
    end(body) {
      captured.body = body === undefined ? '' : String(body)
    },
  }
}

/**
 * Build a fake Host context with in-memory credentials, records, a captured
 * route table, and a captured settings section; apply the plugin.
 * @param configOverrides - plugin config overrides.
 * @param host - which optional services this deployment composes.
 */
async function scaffold(configOverrides = {}, { services = ['settings', 'webServer'] } = {}) {
  resetObserved()
  const config = Plugin.Config.resolve({
    channel: './providers/feishu.js',
    channelConfig: {},
    delaySeconds: 1,
    ...configOverrides,
  })
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const infos = []
  const values = new Map()
  const records = new Map()
  const routes = []
  const sections = new Map()
  const agents = new Map()

  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  }
  const settings = {
    installSection(owner, ns, schema, entry, hooks) {
      sections.set(ns, { schema, entry, hooks })
      hooks.setSource(() => entry)
      hooks.onChange()
    },
  }
  const composed = new Set(services)
  const deferred = []

  /** The context one `inject` callback receives: its services, and effects. */
  const serviceCtx = (deps) => {
    const child = {
      effect(factory) {
        const disposer = factory()
        if (typeof disposer === 'function') disposers.push(disposer)
        return disposer
      },
    }
    for (const dep of deps) child[dep] = dep === 'webServer' ? webServer : settings
    return child
  }

  /** Run every waiting callback whose services are all composed now. */
  const flushInjects = () => {
    for (const [index, waiting] of [...deferred.entries()].reverse()) {
      if (!waiting.deps.every(dep => composed.has(dep))) continue
      deferred.splice(index, 1)
      waiting.callback(serviceCtx(waiting.deps))
    }
  }
  const ctx = {
    logger: {
      warn: (error) => { warnings.push(error) },
      info: (message) => { infos.push(String(message)) },
    },
    agents: {
      get: (id) => agents.get(id),
    },
    credentials: {
      resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
      set: async (ref, value) => { values.set(ref, value) },
      unset: async (ref) => { values.delete(ref) },
      readRecord: async (key) => records.get(key),
      modifyRecord: async (key, mutate) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
      deleteRecord: async (key) => { records.delete(key) },
    },
    get(name) {
      if (!composed.has(name)) return undefined
      if (name === 'webServer') return webServer
      if (name === 'settings') return settings
      return undefined
    },
    inject(deps, callback) {
      deferred.push({ deps, callback })
      flushInjects()
    },
    on(event, handler, options) {
      const entry = { handler, options }
      const list = listeners.get(event) ?? []
      list.push(entry)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(entry)
        if (at !== -1) list.splice(at, 1)
      }
    },
    effect(factory) {
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
  }
  await Plugin.apply(ctx, config)
  await sleep(10)

  /** Drive the registered same-origin route. */
  const route = async (method, path, headers) => {
    const handler = routes[0]
    assert.ok(handler, 'expected the plugin to register a route')
    const res = makeResponse()
    await handler.handler(makeRequest(method, path, headers), res)
    return res.captured
  }
  const json = (captured) => JSON.parse(captured.body)
  const state = async () => json(await route('GET', '/__pocket/state'))
  const listenerOf = (event) => {
    const list = listeners.get(event)
    assert.ok(list?.length, `expected a listener for ${event}`)
    return list[0]
  }
  /** Compose one more optional service, the way a later bundle layer would. */
  const compose = (name) => {
    composed.add(name)
    flushInjects()
  }
  return {
    config, ctx, listeners, disposers, warnings, infos, values, records,
    routes, sections, route, json, state, listenerOf, compose, agents,
  }
}

/**
 * Ask for a binding the way the card does, then let the background onboarding
 * reach the SDK call, which is where the verification link becomes available.
 */
async function requestBinding(route) {
  const response = await route('POST', '/__pocket/bind', SAME_ORIGIN)
  assert.equal(response.status, 200)
  await sleep(10)
  return response
}

/** Complete the pending one-click scan. */
async function scan({ openId = 'ou_bound', appId = 'cli_test' } = {}) {
  assert.ok(observed.completeRegisterApp, 'expected a pending one-click app creation')
  observed.completeRegisterApp({
    client_id: appId,
    client_secret: 'app-secret',
    user_info: { open_id: openId, tenant_brand: 'feishu' },
  })
  await sleep(20)
}

/** Bind end to end: request, scan, and settle. */
async function bind(route, options) {
  await requestBinding(route)
  await scan(options)
}

/** Every callback payload embedded in a card. */
function callbackValues(card) {
  const found = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (Array.isArray(node.behaviors)) {
      for (const behavior of node.behaviors) {
        if (behavior?.type === 'callback') found.push(behavior.value)
      }
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)
  return found
}

/** Parse the single card the channel sent. */
function sentCard() {
  assert.equal(observed.created.length, 1, 'expected exactly one card delivery')
  return JSON.parse(observed.created[0].data.content)
}

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

test('refuses a cross-origin mutation', async () => {
  const { route, json } = await scaffold()
  const refused = await route('POST', '/__pocket/bind', { origin: 'http://evil.example' })
  assert.equal(refused.status, 403)
  assert.equal(json(refused).error, 'cross-origin request refused')
  assert.equal(observed.registerAppCalls.length, 0, 'a refused request must not start onboarding')
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

test('answers a single-select question from its option button', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{
      id: 'deploy',
      header: '发布',
      question: '现在发布到生产吗？',
      options: [{ label: '发布', description: '立即上线' }, { label: '取消' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  assert.match(JSON.stringify(card), /立即上线/, 'an option description must reach the card body')
  assert.equal(JSON.stringify(card).includes('column_set'), false, 'each option takes its own full-width row')

  const chosen = callbackValues(card).find(value => value.v === '发布')
  assert.ok(chosen, 'the option label must be offered as a button')
  assert.equal(chosen.q, 'deploy')

  const typed = callbackValues(card).find(value => value.submit === true)
  assert.ok(typed, 'a single-select question must also accept a typed answer')
  assert.equal(typed.q, 'deploy')

  await clickCard(chosen)
  assert.deepEqual(await result, { answers: [{ id: 'deploy', selected: ['发布'] }] })
})

test('accumulates answers until every question is answered', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [
      { id: 'a', question: 'A?', options: [{ label: 'a1' }] },
      { id: 'b', question: 'B?', options: [{ label: 'b1' }] },
    ],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const values = callbackValues(sentCard())
  const partial = await clickCard(values.find(value => value.q === 'a'))
  assert.match(partial.toast.content, /1\/2/, 'a partial answer must not settle the request')

  await sleep(20)
  assert.equal(observed.patched.length, 1, 'the card is rewritten so the recorded answer is visible')
  const rewritten = JSON.parse(observed.patched[0].data.content)
  assert.match(JSON.stringify(rewritten), /已答 1\/2/, 'the progress line advances')
  assert.match(JSON.stringify(rewritten), /✅ a1/, 'the chosen answer stays visible')
  assert.deepEqual(
    [...new Set(callbackValues(rewritten).map(value => value.q))],
    ['b'],
    'the answered question loses its controls while the open one keeps them',
  )

  await clickCard(values.find(value => value.q === 'b'))
  assert.deepEqual(await result, {
    answers: [
      { id: 'a', selected: ['a1'] },
      { id: 'b', selected: ['b1'] },
    ],
  })
})

test('accepts a multi-select form submission with a typed answer beside the choices', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{
      id: 'pick',
      question: '选哪些？',
      multiSelect: true,
      options: [{ label: 'x' }, { label: 'y' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  assert.ok(submit, 'a multi-select question needs a submit button')
  assert.match(JSON.stringify(card), /"name":"custom"/, 'a multi-select form carries a typed answer beside its choices')

  await clickCard(submit, { value: ['x', 'y'], custom: '带上发布说明' })
  assert.deepEqual(await result, {
    answers: [{ id: 'pick', selected: ['x', 'y'], custom: '带上发布说明' }],
  })
})

test('a multi-select submission without typed text carries no custom answer', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{
      id: 'pick',
      question: '选哪些？',
      multiSelect: true,
      options: [{ label: 'x' }, { label: 'y' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const submit = callbackValues(sentCard()).find(value => value.submit === true)
  await clickCard(submit, { value: ['x'], custom: '   ' })
  assert.deepEqual(
    await result,
    { answers: [{ id: 'pick', selected: ['x'] }] },
    'blank text is not an answer',
  )
})

test('accepts a free-text form submission when the question offers no options', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{ id: 'note', question: '有什么要补充的？' }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  assert.match(JSON.stringify(card), /"tag":"input"/, 'a no-option question needs a text field')

  const submit = callbackValues(card).find(value => value.submit === true)
  await clickCard(submit, { value: '按 B 方案来' })
  assert.deepEqual(await result, {
    answers: [{ id: 'note', selected: [], custom: '按 B 方案来' }],
  })
})

test('rejects an unknown request id and a forged option label', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')
  void questions.handler({
    questions: [{ id: 'q', question: 'Q?', options: [{ label: 'ok' }] }],
    signal: new AbortController().signal,
  }, () => Promise.withResolvers().promise)
  await sleep(1200)
  const rid = callbackValues(sentCard())[0].rid

  const expired = await clickCard({ rid: 'nope', v: 'ok' })
  assert.equal(expired.toast.type, 'warning')

  const forged = await clickCard({ rid, q: 'q', v: '模型没提供过的选项' })
  assert.equal(forged.toast.type, 'warning', 'an answer no option offered must be refused')
  assert.equal(observed.patched.length, 0, 'a refused answer must not close the request')
})

test('re-binding follows a direct message from a new account', async () => {
  const { route, records } = await scaffold()
  await bind(route, { openId: 'ou_first' })
  await directMessage('ou_second')
  assert.deepEqual(records.get('pocket-console/recipient').payload, { id: 'ou_second' })
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

test('the browser half loads through the module loader and registers its card', async () => {
  // The browser half is hand-written in the client module system's factory
  // format, so it can be executed here against a stand-in shell: this is the
  // only way to check its shape without a browser.
  const FakeReact = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useState: (initial) => [initial, () => {}],
  }
  /**
   * The shell seeds a fixed module table and nothing else resolves in the page.
   * This mirrors what the installed shell seeds — React and the UI primitives —
   * so a request for any other package fails here the way it fails in a browser,
   * instead of being papered over by a stub the real page never provides. Which
   * package owns the store engine, for instance, has moved between releases.
   */
  const baseline = {
    react: FakeReact,
    '@deepseek-ai/dsh-client-ui-primitives': { IconChevronDownOutline14: () => null },
  }
  /**
   * Load the bundle behind one stand-in shell.
   * @param url - module URL to load, query included.
   * @returns the id, exports, and requested specifiers the loader captured.
   */
  const load = async (url) => {
    let loaded
    const requested = []
    const previous = globalThis.window
    globalThis.window = {
      __ModuleLoader__: {
        load({ id, factory }) {
          loaded = {
            id,
            exports: factory((specifier) => {
              requested.push(specifier)
              assert.ok(Object.hasOwn(baseline, specifier), `the card may only request shell-seeded modules, asked for ${specifier}`)
              return baseline[specifier]
            }),
          }
        },
      },
    }
    try {
      await import(url)
    } finally {
      globalThis.window = previous
    }
    return { ...loaded, requested }
  }

  const loaded = await load('./client.js?verify')
  assert.equal(loaded.id, 'dsh-pocket-console', 'the module-table row id is the package name')
  assert.deepEqual(loaded.exports.inject, ['slots', 'settingsScope'])
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.deepEqual(
    [...new Set(loaded.requested)].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react'],
    'the bundle requests only modules the shell seeds',
  )

  const base = { delaySeconds: 120, maxDetailChars: 1200, titlePrefix: 'DSH' }
  let section = { ...base }
  let user
  const scopeListeners = new Set()
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: section,
      base,
      user,
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe(listener) {
      scopeListeners.add(listener)
      return () => { scopeListeners.delete(listener) }
    },
    async set(field, value) {
      user = { ...(user ?? {}), [field]: value }
      section = { ...section, [field]: value }
      for (const listener of scopeListeners) listener()
    },
    async unset(field) {
      if (user !== undefined) {
        const next = { ...user }
        delete next[field]
        user = Object.keys(next).length === 0 ? undefined : next
      }
      section = { ...section, [field]: base[field] }
      for (const listener of scopeListeners) listener()
    },
  }
  /**
   * Apply one loaded browser half against a stand-in host context.
   * @param module - the loaded browser half.
   * @returns what the card registered and bound.
   */
  const applyTo = (module) => {
    const seen = { inject: [], register: [], bind: undefined }
    module.apply({
      settingsScope: { bind(spec) { seen.bind = spec; return scope } },
      slots: {
        inject(name, contribute) {
          seen.inject.push(name)
          contribute()
        },
        register(options, Component) {
          seen.register.push({ options, Component })
        },
      },
    })
    return { ...seen, registered: seen.register.at(-1) }
  }

  const first = applyTo(loaded.exports)
  assert.deepEqual(first.inject, ['settings.plugin.item'])
  assert.deepEqual(first.bind, { namespace: 'pocket-console' }, 'the card binds its own settings namespace')
  assert.equal(first.registered.options.key, 'pocket-console', 'the card is keyed by the settings namespace')
  assert.equal(typeof first.registered.Component, 'function')

  const face = first.registered.options.inject()
  assert.equal(typeof face.copy.title, 'string')
  assert.equal(typeof face.edit, 'function')
  assert.equal(typeof face.resetField, 'function')
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.discard, 'function')
  assert.equal(typeof face.hooks.pocketConsole.getSnapshot, 'function', 'form state rides the hooks compartment')

  // The card edits its own namespace: it stages what the user types, writes on
  // save, and shows whether the user layer carries a field.
  const card = face.hooks.pocketConsole
  assert.equal(card.getSnapshot().shell.dirty, false)
  assert.deepEqual(card.getSnapshot().delaySeconds, { text: '120', overridden: false, invalid: false })

  face.edit('delaySeconds', '300')
  assert.equal(card.getSnapshot().shell.dirty, true, 'an edit stages instead of writing')
  assert.equal(section.delaySeconds, 120, 'nothing reaches the document before a save')

  await face.save()
  assert.equal(section.delaySeconds, 300, 'a save writes the staged value')
  assert.equal(card.getSnapshot().shell.dirty, false)
  assert.equal(card.getSnapshot().delaySeconds.overridden, true, 'the field now carries a user-layer entry')

  face.edit('delaySeconds', '不是数字')
  assert.equal(card.getSnapshot().delaySeconds.invalid, true, 'a draft the field cannot accept blocks the save')
  await face.save()
  assert.equal(section.delaySeconds, 300, 'an invalid draft writes nothing')

  face.resetField('delaySeconds')
  await face.save()
  assert.equal(section.delaySeconds, 120, 'a reset re-inherits the composition layer')
  assert.equal(card.getSnapshot().delaySeconds.overridden, false)

  // The shell publishes the active language on <html>; the card follows it.
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  try {
    const chinese = await load('./client.js?verify-zh')
    assert.equal(applyTo(chinese.exports).registered.options.inject().copy.title, '口袋控制台')
  } finally {
    delete globalThis.document
  }
})

/**
 * Drive one session through the recorded event sequence: a person starts it, a
 * tool-calling message is process, the last message is the answer, and the turn
 * ends.
 * @param emit - the `session/event` listener.
 * @param id - session id.
 * @param answer - the answer text.
 */
function runTurn(emit, id, answer = '构建已经通过。') {
  emit({ id }, { type: 'user/message', data: { source: { kind: 'user' } } })
  emit({ id }, { type: 'turn/start', data: { turn: 1 } })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: '我先看看' }, { type: 'tool-call', name: 'pwsh' }] } },
  })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'pwsh' }] } },
  })
  emit({ id }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, message: { content: [{ type: 'text', text: answer }] } },
  })
  emit({ id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
  const toast = await clickCard(submit, { value: '接着把文档补上' })
  assert.equal(toast.toast.content, '已发送给 agent')
  await sleep(10)
  assert.equal(followed.length, 1)
  assert.equal(followed[0].content[0].text, '接着把文档补上')
  assert.deepEqual(followed[0].source, { kind: 'plugin', plugin: 'pocket-console' },
    'an instruction from the phone is plugin-sourced, never human-attested')

  const replayed = await clickCard(submit, { value: '再来一次' })
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
  busy.agents.set('s_busy', { status: 'working', followup: () => {} })
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
