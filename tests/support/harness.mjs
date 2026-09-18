/**
 * Shared suite harness for dsh-pocket-console: a fake Host context with stubbed
 * Feishu and QR
 * libraries: settings registration, the same-origin routes, onboarding before
 * and after the scan, escalation timing, callback decoding, the desktop-first
 * race, abort handling, and disposal.
 *
 * Run: node verify.mjs
 */

import assert from 'node:assert/strict'
import { observed, resetObserved } from '@larksuiteoapi/node-sdk'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import * as Plugin from '../../index.js'

const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) })

const HOST = '127.0.0.1:3080'
const SAME_ORIGIN = { origin: `http://${HOST}` }

/**
 * The recipient the fake deployment is bound to. A click is only honoured from
 * this identity, so the helper sends it; a case that tests the refusal passes
 * its own.
 */
const bound = { recipient: 'ou_bound' }

/**
 * Click one button the way the long connection delivers it: through the
 * dispatcher, inside the v2 envelope whose `event` the SDK flattens before the
 * handler sees it.
 * @param value - the clicked button's payload.
 * @param formValue - submitted form values, keyed by input name.
 * @param options - the pressing identity, defaulting to whoever is bound.
 * @returns the channel's response, whose toast reports the outcome.
 */
async function clickCard(value, formValue, { operator = bound.recipient } = {}) {
  return await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      action: { value, ...(formValue === undefined ? {} : { form_value: formValue }) },
      operator: { open_id: operator },
      context: { open_message_id: 'om_stub_1' },
    },
  })
}

/**
 * Send one direct message, which is how an unbound deployment learns who its
 * operator is.
 *
 * The envelope carries `message.chat_type`, because the platform does: a
 * handler that cannot tell a direct message from a group one cannot refuse the
 * second, and a group sender is not this deployment's operator.
 * @param openId - the sender's open id.
 * @returns the handler's return value.
 */
async function directMessage(openId) {
  bound.recipient = openId
  return await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: { chat_type: 'p2p' },
      sender: { sender_id: { open_id: openId } },
    },
  })
}

/**
 * One HTTP request shaped as the webserver hands it to a route handler.
 *
 * A string body is sent verbatim, so a case can exercise a body that is not JSON or
 * one past the route's size limit — the two ways a caller gets it wrong. Anything else
 * is serialised.
 * @param method - the HTTP method.
 * @param path - the request path.
 * @param headers - extra headers, merged over the host.
 * @param body - a JSON value, or a raw string to send as written.
 */
function makeRequest(method, path, headers = {}, body) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    url: path,
    headers: { host: HOST, ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
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
 * @param host - which optional services this deployment composes, what the
 *   credential store already holds from an earlier run, whether that store refuses
 *   writes (the environment layer shadows the reference), and what the platform
 *   answers when the stored pair is checked at load.
 */
async function scaffold(configOverrides = {}, {
  services = ['settings', 'webServer'],
  stored = {},
  refuseWrites = false,
  tenantToken,
} = {}) {
  resetObserved()
  if (tenantToken !== undefined) observed.tenantToken = tenantToken
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
  const debugs = []
  const values = new Map()
  const records = new Map()
  const routes = []
  const sections = new Map()
  const agents = new Map()

  // A deployment that has already onboarded: the app credentials and the bound
  // recipient are what an earlier run persisted.
  if (stored.appId !== undefined) values.set(credentialRef('DSH_FEISHU_APP_ID'), stored.appId)
  if (stored.appSecret !== undefined) values.set(credentialRef('DSH_FEISHU_APP_SECRET'), stored.appSecret)
  if (stored.recipient !== undefined) {
    bound.recipient = stored.recipient
    records.set(credentialKey('pocket-console', 'recipient'), {
      kind: 'grant',
      payload: { id: stored.recipient },
    })
  }

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
      // The real provider hands over a source exactly once and afterwards only
      // reports that something changed, so a case edits the user layer and calls
      // `change()` — never `setSource` again. A plugin that kept the value it read
      // at install time therefore fails here, which is what the running application
      // was doing: a card edit that needed a restart to take effect.
      const layer = {}
      sections.set(ns, {
        schema,
        entry,
        hooks,
        layer,
        change(mutate) {
          if (mutate !== undefined) mutate(layer)
          hooks.onChange()
        },
      })
      // Effective value: what the deployment composed, with the user layer on top.
      hooks.setSource(() => ({ ...entry, ...layer }))
      hooks.onChange()
    },
  }
  const composed = new Set(services)
  /** What the composed trust fence answers, when one is composed. */
  let rejection
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
      debug: (message) => { debugs.push(String(message)) },
    },
    credentials: {
      resolve: async (ref) => (values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined),
      set: async (ref, value) => {
        // The real store refuses a write the process environment would shadow:
        // it would take effect nowhere and report success. A case reproduces
        // that refusal to prove the connection still uses what was typed.
        if (refuseWrites) throw new Error(`an inherited environment value shadows "${ref}"`)
        values.set(ref, value)
      },
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
      // The agent registry is core rather than an optional service, so it is
      // reachable whether or not this deployment composed the optional pair.
      // Reading it through `get` is also what keeps a deployment without it
      // loadable: a service property read would throw without an `inject`.
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (!composed.has(name)) return undefined
      if (name === 'webServer') return webServer
      if (name === 'settings') return settings
      // The browser surface's trust fence: present in a GUI deployment, and the
      // routes must ask it before answering anything.
      if (name === 'connection') return { requestRejection: () => rejection }
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
  // Cordis throws when a service property is read without an `inject`
  // declaration, so this context does too: a plugin that reaches a service
  // directly fails here rather than on a user's machine. Services are reached
  // through `get`, which is the accessor that needs no declaration.
  const guarded = new Proxy(ctx, {
    get(target, key) {
      if (key in target) return target[key]
      throw new Error(`cannot get property "${String(key)}" without inject`)
    },
  })
  await Plugin.apply(guarded, config)
  await sleep(10)

  /** Drive the registered same-origin route. */
  const route = async (method, path, headers, body) => {
    const handler = routes[0]
    assert.ok(handler, 'expected the plugin to register a route')
    const res = makeResponse()
    await handler.handler(makeRequest(method, path, headers, body), res)
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
    bound, setRejection: (status) => { rejection = status },
    config, ctx, listeners, disposers, warnings, infos, debugs, values, records,
    routes, sections, route, json, state, listenerOf, compose, agents,
  }
}

/**
 * Ask for a binding the way the card does, then let the background onboarding
 * reach the SDK call, which is where the verification link becomes available.
 *
 * The answer to the click reports the wait it started — the QR code is a network
 * round trip away — and that is what the card shows in the meantime.
 */
async function requestBinding(route) {
  const response = await route('POST', '/__pocket/bind', SAME_ORIGIN)
  assert.equal(response.status, 200)
  const answering = JSON.parse(response.body)
  assert.equal(answering.state, 'starting', 'the click answers with the work it started')
  assert.equal(answering.stage, 'creating', 'and says which work that is')
  await sleep(10)
  return response
}

/** Complete the pending one-click scan. */
async function scan({ openId = 'ou_bound', appId = 'cli_test' } = {}) {
  bound.recipient = openId
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

/**
 * The name of each form control in a card, in the order the card declares them.
 *
 * A card's form answers arrive keyed by the name the element carries, so a test that
 * wants to submit one has to read that name off the card rather than assume it: the
 * channel is free to name its controls to suit the card it is building.
 */
function controlNames(card) {
  return card.body.elements
    .flatMap(element => element.elements ?? [])
    .filter(element => element.tag === 'input' || element.tag === 'checker')
    .map(element => element.name)
}

/** Parse the single card the channel sent. */
function sentCard() {
  assert.equal(observed.created.length, 1, 'expected exactly one card delivery')
  return JSON.parse(observed.created[0].data.content)
}


export {
  sleep,
  bound,
  HOST,
  SAME_ORIGIN,
  clickCard,
  directMessage,
  makeRequest,
  makeResponse,
  scaffold,
  requestBinding,
  scan,
  bind,
  callbackValues,
  controlNames,
  sentCard,
  observed,
  resetObserved,
  Plugin,
}
