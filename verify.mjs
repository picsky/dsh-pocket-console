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
 */
async function scaffold(configOverrides = {}) {
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
  const ctx = {
    logger: {
      warn: (error) => { warnings.push(error) },
      info: (message) => { infos.push(String(message)) },
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
      if (name === 'webServer') return webServer
      if (name === 'settings') return settings
      return undefined
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
  return {
    config, ctx, listeners, disposers, warnings, infos, values, records,
    routes, sections, route, json, state, listenerOf,
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

test('reports unbound state and does not escalate before binding', async () => {
  const { state, listenerOf, infos } = await scaffold()

  const snapshot = await state()
  assert.equal(snapshot.namespace, 'pocket-console')
  assert.equal(snapshot.pending, 0)
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
  const toast = await observed.handlers['card.action.trigger']({
    event: { action: { value: { rid, v: 'allowed-once' } }, context: { open_message_id: 'om_stub_1' } },
  })
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
      options: [{ label: '发布' }, { label: '取消' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const chosen = callbackValues(sentCard()).find(value => value.v === '发布')
  assert.ok(chosen, 'the option label must be offered as a button')
  assert.equal(chosen.q, 'deploy')

  await observed.handlers['card.action.trigger']({
    event: { action: { value: chosen }, context: { open_message_id: 'om_stub_1' } },
  })
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
  const partial = await observed.handlers['card.action.trigger']({
    event: { action: { value: values.find(value => value.q === 'a') }, context: {} },
  })
  assert.match(partial.toast.content, /1\/2/, 'a partial answer must not settle the request')

  await sleep(20)
  assert.equal(observed.patched.length, 1, 'the card is rewritten so the recorded answer is visible')
  const rewritten = JSON.parse(observed.patched[0].data.content)
  assert.match(JSON.stringify(rewritten), /已答 1\/2/, 'the progress line advances')
  assert.match(JSON.stringify(rewritten), /✅ a1/, 'the chosen answer stays visible')
  assert.deepEqual(
    callbackValues(rewritten).map(value => value.q),
    ['b'],
    'the answered question loses its controls while the open one keeps them',
  )

  await observed.handlers['card.action.trigger']({
    event: { action: { value: values.find(value => value.q === 'b') }, context: {} },
  })
  assert.deepEqual(await result, {
    answers: [
      { id: 'a', selected: ['a1'] },
      { id: 'b', selected: ['b1'] },
    ],
  })
})

test('accepts a multi-select form submission', async () => {
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
  assert.ok(submit, 'a multi-select question needs a submit button')

  await observed.handlers['card.action.trigger']({
    event: { action: { value: submit, form_value: { value: ['x', 'y'] } }, context: {} },
  })
  assert.deepEqual(await result, { answers: [{ id: 'pick', selected: ['x', 'y'] }] })
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
  await observed.handlers['card.action.trigger']({
    event: { action: { value: submit, form_value: { value: '按 B 方案来' } }, context: {} },
  })
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

  const expired = await observed.handlers['card.action.trigger']({
    event: { action: { value: { rid: 'nope', v: 'ok' } }, context: {} },
  })
  assert.equal(expired.toast.type, 'warning')

  const forged = await observed.handlers['card.action.trigger']({
    event: { action: { value: { rid, q: 'q', v: '模型没提供过的选项' } }, context: {} },
  })
  assert.equal(forged.toast.type, 'warning', 'an answer no option offered must be refused')
  assert.equal(observed.patched.length, 0, 'a refused answer must not close the request')
})

test('re-binding follows a direct message from a new account', async () => {
  const { route, records } = await scaffold()
  await bind(route, { openId: 'ou_first' })
  await observed.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_second' } },
  })
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

test('the browser half loads through the module loader and registers its card', async () => {
  // The browser half is hand-written in the client module system's factory
  // format, so it can be executed here against a stand-in shell: this is the
  // only way to check its shape without a browser.
  const calls = { inject: [], register: [] }
  const FakeReact = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useState: (initial) => [initial, () => {}],
  }
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = {
          id,
          exports: factory((specifier) => {
            assert.equal(specifier, 'react', `the card may only request platform modules, asked for ${specifier}`)
            return FakeReact
          }),
        }
      },
    },
  }
  try {
    await import('./client.js?verify')
  } finally {
    delete globalThis.window
  }

  assert.equal(loaded.id, 'dsh-pocket-console', 'the module-table row id is the package name')
  assert.deepEqual(loaded.exports.inject, ['slots'])
  assert.equal(typeof loaded.exports.apply, 'function')

  const ctx = {
    slots: {
      inject(name, contribute) {
        calls.inject.push(name)
        contribute()
      },
      register(options, Component) {
        calls.register.push({ options, Component })
      },
    },
  }
  loaded.exports.apply(ctx)

  assert.deepEqual(calls.inject, ['settings.plugin.item'])
  assert.equal(calls.register.length, 1)
  assert.equal(calls.register[0].options.key, 'pocket-console', 'the card is keyed by the settings namespace')
  assert.equal(typeof calls.register[0].Component, 'function')
  assert.equal(typeof calls.register[0].options.inject().copy.title, 'string')
})
