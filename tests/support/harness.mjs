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
import { createStorageDomain, resetDurable } from '@deepseek-ai/dsh-storage-domain'
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
 * The message handle this deployment was last given, which is what a press carries.
 * @returns the handle, or a placeholder when nothing has been sent yet.
 */
function lastDelivered() {
  return observed.delivered.at(-1)?.handle ?? 'om_0'
}

/**
 * The card that lives in one message, as it stands now.
 *
 * The newest edit of that message if it has been edited, and the message it was sent as
 * otherwise — located by the handle the platform returned, which is the only thing that ties an
 * edit to its card.
 * @param handle - the message handle a delivery was given.
 * @returns the rendered card JSON, or undefined when no such message was accepted.
 */
function cardFrom(handle) {
  const delivered = observed.delivered.find(entry => entry.handle === handle)
  if (delivered === undefined) return undefined
  const edited = observed.patched.findLast(entry => entry.path?.message_id === handle)
  try {
    return JSON.parse((edited ?? delivered.request).data.content)
  } catch {
    return undefined
  }
}

/**
 * Every card this deployment has sent, in order, as `{ handle, card }`.
 * @returns one entry per accepted delivery.
 */
function cardsSent() {
  return observed.delivered.map(entry => ({ handle: entry.handle, card: cardFrom(entry.handle) }))
}

/**
 * The first card whose title starts with one prefix, with the handle it lives in.
 *
 * Titles are how a case names the card it means without depending on delivery order: several
 * machines in this plugin send cards, and which one goes first is a property of the deployment
 * rather than of the behaviour under test.
 * @param prefix - the start of the card title.
 * @returns the handle and card, or undefined when no card has that title.
 */
function cardTitled(prefix) {
  for (const entry of observed.delivered) {
    const card = cardFrom(entry.handle)
    if (typeof card?.header?.title?.content === 'string'
      && card.header.title.content.startsWith(prefix)) {
      return { handle: entry.handle, card }
    }
  }
  return undefined
}

/**
 * Click one button the way the long connection delivers it: through the
 * dispatcher, inside the v2 envelope whose `event` the SDK flattens before the
 * handler sees it.
 * @param value - the clicked button's payload.
 * @param formValue - submitted form values, keyed by input name.
 * @param options - the pressing identity, defaulting to whoever is bound.
 * @returns the channel's response, whose toast reports the outcome.
 */
async function clickCard(value, formValue, { operator = bound.recipient, messageId } = {}) {
  return await observed.dispatcher.invoke({
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      action: { value, ...(formValue === undefined ? {} : { form_value: formValue }) },
      operator: { open_id: operator },
      // The press carries the message it came from, which is what a rewrite of "the card the
      // press came from" is addressed by. Defaulting to the last message this deployment was
      // given keeps that name true for the cards a case has actually caused.
      context: { open_message_id: messageId ?? lastDelivered() },
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
 * The fake session log as it outlives a process: which sessions exist, and where a
 * person has spoken in each. Durable like the storage medium, and reset with it.
 */
const corpus = new Map()

/**
 * The disposers of the deployment currently loaded, so the next case can shut it down.
 *
 * One deployment exists at a time in a test process, and leaving one loaded is what puts a
 * stale card edit into the next case's log.
 */
let openDeployment = []

/**
 * Shut down the deployment a previous case left loaded.
 *
 * Called before a new one is built rather than after the old case ends, because a case cannot be
 * relied on to clean up: it may have failed its last assertion, and a leaked timer would then
 * corrupt whatever ran next. What matters is that its timers are cleared and its listeners
 * removed — not that it exits well, so a disposer that throws is swallowed here.
 */
function disposePrevious() {
  const closing = openDeployment
  openDeployment = []
  for (const dispose of closing) {
    try {
      dispose()
    } catch {
      // The deployment's own business; the next case is what this protects.
    }
  }
}

/**
 * Build a fake Host context with in-memory credentials, records, a captured
 * route table, and a captured settings section; apply the plugin.
 * @param configOverrides - plugin config overrides.
 * @param host - which optional services this deployment composes, what the
 *   credential store already holds from an earlier run, whether that store refuses
 *   writes (the environment layer shadows the reference), what the platform
 *   answers when the stored pair is checked at load, whether the durable
 *   medium survives from the previous scaffold (a restart), and whether the
 *   storage medium is held shut so a case can press a card before it answers.
 */async function scaffold(configOverrides = {}, {
  services = ['settings', 'webServer', 'storageDomain', 'sessionQuery', 'sessionController', 'sessionTitle'],
  stored = {},
  refuseWrites = false,
  tenantToken,
  keepDurable = false,
  holdStorage = false,
} = {}) {
  // The previous deployment is shut down before anything of this one exists.
  //
  // A deployment that is still loaded keeps working: a throttled card edit sits on a timer, a
  // channel holds a long connection, a notice waits out its quiet window. Those timers fire
  // after the case that created them has finished, and a call they make lands in *this* case's
  // observation log — a stale write attributed to the wrong case, which reads exactly like a
  // real failure. Disposing first makes the log a record of one deployment's behaviour.
  disposePrevious()
  resetObserved()
  // The durable medium — the storage hub and the session logs — is what a restart does
  // not take with it, so a case modelling one keeps it and every other case starts clean.
  if (!keepDurable) {
    resetDurable()
    corpus.clear()
  }
  if (tenantToken !== undefined) observed.tenantToken = tenantToken
  const config = Plugin.Config.resolve({
    channel: './providers/feishu.js',
    channelConfig: {},
    delaySeconds: 1,
    ...configOverrides,
  })
  const listeners = new Map()
  const disposers = []
  // Published as the deployment's own, so the next case shuts this one down before it starts:
  // a machine still loaded edits its card on a timer, and that edit would land in the next
  // case's log.
  openDeployment = disposers
  const warnings = []
  const infos = []
  const debugs = []
  const values = new Map()
  const records = new Map()
  const routes = []
  const sections = new Map()
  const agents = new Map()
  /**
   * The agent registry the deployment and the cases see.
   *
   * The real registry always hands back a session that carries its own id; the fake stores agents
   * without one, so the id is supplied on the way in. The map is wrapped rather than copied on `get`,
   * because a case mutates an agent in place to model a session that starts working mid-turn
   * (`agents.get(id).status = 'running'`) and a copy would hide that from the deployment.
   */
  const withSessionId = (id, agent) => ({ ...agent, session: { id, ...agent.session } })
  const registry = {
    set: (id, agent) => { agents.set(id, withSessionId(id, agent)); return registry },
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    has: (id) => agents.has(id),
    delete: (id) => agents.delete(id),
    clear: () => agents.clear(),
    get size() { return agents.size },
  }
  /**
   * The folded session titles the title service answers with, by session id.
   *
   * Empty unless a case fills it: a deployment's sessions have titles the plugin never saw an event
   * for, and this is how a case models that.
   */
  const titles = new Map()
  const storageDomain = createStorageDomain()
  /**
   * A gate a case can hold shut to model a medium that has not answered yet — the window
   * in which a press must not conclude that a notice is gone.
   */
  let storageGate
  if (holdStorage) {
    const held = Promise.withResolvers()
    storageGate = held
    const inner = storageDomain.open.bind(storageDomain)
    storageDomain.open = async (spec) => {
      await held.promise
      return await inner(spec)
    }
  }
  /**
   * The session controller, as far as this plugin uses it: creating a session.
   *
   * A stub that records what it was asked to create, so a case can assert the workspace a new
   * session inherited rather than only that some session exists. It creates the agent too, because
   * the plugin sends the first prompt through the agent rather than through `prompt()` — the
   * controller's `prompt()` stamps a gateway request id onto the message, which the deployment
   * reads as somebody typing at the desk, and a task started from the phone must not look like one.
   */
  const sessionController = {
    /** Every session created here, with the request it was created from. */
    created: [],
    async create(request) {
      const id = `session-${sessionController.created.length + 1}`
      sessionController.created.push({ id, request })
      // What `ensureSession` does in the Host: the session exists and has an agent, so the first
      // prompt has somewhere to go. The recorded follow-ups are what a case inspects.
      const agent = { status: 'idle', followed: [], followup: (message) => { agent.followed.push(message) } }
      registry.set(id, agent)
      return { sessionId: id }
    },
  }

  /** The session log as the query service reports it; durable, so declared above. */
  const sessionQuery = {
    /**
     * Note that a session exists, with the highest seq its log has reached.
     * @param session - the session id.
     * @param lastSeq - the highest event seq, defaulting to 1 for a session with a log.
     */
    exists(session, lastSeq = 1) {
      const entry = corpus.get(session) ?? { lastSeq: 0, spokeAt: [] }
      entry.lastSeq = Math.max(entry.lastSeq, lastSeq)
      corpus.set(session, entry)
      return entry
    },
    /**
     * Note that a person spoke in one session, which is what retires a notice.
     * @param session - the session id.
     * @param seq - the seq the person's message landed at.
     */
    personSpoke(session, seq) {
      const entry = this.exists(session, seq)
      entry.spokeAt.push(seq)
      return entry
    },
    /** Every session's highest seq, for a notice to record when it goes out. */
    async readSurface(session) {
      const entry = corpus.get(session)
      return { capturedThroughSeq: entry === undefined ? null : entry.lastSeq }
    },
    /**
     * The events matching every filter, with only the two filters this plugin uses
     * implemented: a seq floor and an event type.
     * @param session - the session to scan.
     * @param filters - the ANDed filters.
     * @returns the matching records, in seq order.
     */
    async filterEvents(session, filters) {
      const from = filters.find(filter => filter.kind === 'seq')?.from ?? 0
      const types = filters.find(filter => filter.kind === 'type')?.values ?? []
      const wanted = types.includes('user/message')
      const entry = corpus.get(session)
      if (entry === undefined || !wanted) return []
      return entry.spokeAt
        .filter(seq => seq >= from)
        .map(seq => ({ sessionId: session, seq, type: 'user/message', time: 0, surface: 'current' }))
    },
    /**
     * The sessions matching every filter, with the id filter this plugin uses.
     * @param filters - the ANDed filters.
     * @returns one record per matching session.
     */
    async filterSessions(filters) {
      const ids = new Set(filters.flatMap(filter => (filter.kind === 'id' ? [...filter.values] : [])))
      return [...ids].filter(id => corpus.has(id)).map(id => ({ session: { id }, live: false, persisted: true }))
    },
  }

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
  // The side the person was on, as an earlier run left it. A restart is what has to read
  // this back: a person away must not be put behind a desk head start by a new process.
  if (stored.priority !== undefined) {
    records.set(credentialKey('pocket-console', 'priority'), {
      kind: 'grant',
      payload: { side: stored.priority },
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
      // `list` mirrors the real registry's enumeration, which is how a card is minted for a session
      // that is already running when the person moves to the phone. The fake agents are stored
      // without a `session.id`, so it is supplied here the way the real one always has it.
      if (name === 'agents') {
        return { get: registry.get, list: registry.list }
      }
      if (!composed.has(name)) return undefined
      if (name === 'webServer') return webServer
      if (name === 'settings') return settings
      if (name === 'storageDomain') return storageDomain
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'sessionController') return sessionController
      // The title service reads one session's folded title, which is what a card falls back to when
      // the plugin never saw that session's `session/title` event.
      if (name === 'sessionTitle') return { get: (session) => titles.get(session?.id) }
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
  /**
   * Feed one event to every listener registered for it.
   *
   * An event may have more than one listener — several machines in this plugin follow the
   * session feed — and a case about the second one has to reach it. Cordis dispatches to all
   * of them, so a case that only called the first would be testing something the deployment
   * does not do.
   *
   * A frame event is delivered as Cordis delivers it: an agent-scoped listener is called with
   * **one** argument, the payload `{ agent, frame }`. Handing it the frame beside the payload
   * would let a case pass against a call convention the deployment never produces — which is
   * how the live-stream listener once shipped reading a second argument that never arrived.
   * @param event - the event name.
   * @param args - the arguments every listener receives.
   */
  const emitToAll = (event, ...args) => {
    for (const entry of [...(listeners.get(event) ?? [])]) entry.handler(...args)
  }
  /**
   * Feed one live stream frame to every listener, the way Cordis does.
   * @param agentId - the session the attempt belongs to.
   * @param frame - the start, chunk or end publication.
   */
  const emitFrame = (agentId, frame) => {
    emitToAll('agent/assistant-stream', { agent: { id: agentId }, frame })
  }
  /** Compose one more optional service, the way a later bundle layer would. */
  const compose = (name) => {
    composed.add(name)
    flushInjects()
  }
  return {
    bound, setRejection: (status) => { rejection = status },
    config, ctx, listeners, disposers, warnings, infos, debugs, values, records,
    routes, sections, route, json, state, listenerOf, compose, agents: registry, titles, emitToAll, emitFrame,
    lastDelivered, cardFrom, cardsSent, cardTitled,
    sessionQuery, storageDomain, sessionController,
    /** Let a held medium answer, so the pending open and restore can finish. */
    releaseStorage: () => { storageGate?.resolve() },
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
  lastDelivered,
  cardFrom,
  cardsSent,
  cardTitled,
  Plugin,
}
