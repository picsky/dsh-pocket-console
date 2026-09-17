/**
 * Local stand-in for `@larksuiteoapi/node-sdk`. It records every outbound call,
 * exposes the registered handlers, and lets a test drive the one-click app
 * creation flow without Feishu credentials or a network.
 */

/** Every call this stub observed, for assertions. */
export const observed = {
  created: [],
  patched: [],
  /** The dispatcher the channel registered its handlers on. */
  dispatcher: undefined,
  /** The options the dispatcher was built with, including its log routing. */
  dispatcherOptions: undefined,
  started: 0,
  closed: 0,
  registerAppCalls: [],
  /** Set to make the next delivery fail with that message. */
  failNextDelivery: undefined,
  /** How many deliveries the platform refused. */
  deliveryFailures: 0,
  /** Completes the pending `registerApp()` promise; set while it is pending. */
  completeRegisterApp: undefined,
  /** Rejects the pending `registerApp()` promise. */
  failRegisterApp: undefined,
  /**
   * What a started long connection does: `ready` completes the handshake on the
   * next tick, `held` leaves it unfinished, and `failed` reports through the
   * error callback — which is what the platform does for a rejected pair.
   */
  handshake: 'ready',
  /** The reason a `failed` handshake reports. */
  handshakeError: 'handshake failed',
  /** Every long connection built, so a case can see the callbacks it was given. */
  wsClients: [],
  /** Every generic SDK request made: the credential check. */
  requests: [],
  /**
   * What the tenant-token call answers: nothing set accepts the pair, `{ code, msg }`
   * answers with a rejection body, and `{ throws }` fails the way the SDK does.
   */
  tenantToken: {},
}

/** Reset recorded calls between cases. */
export function resetObserved() {
  observed.created.length = 0
  observed.patched.length = 0
  observed.dispatcher = undefined
  observed.dispatcherOptions = undefined
  observed.started = 0
  observed.closed = 0
  observed.registerAppCalls.length = 0
  observed.failNextDelivery = undefined
  observed.deliveryFailures = 0
  observed.completeRegisterApp = undefined
  observed.failRegisterApp = undefined
  observed.handshake = 'ready'
  observed.handshakeError = 'handshake failed'
  observed.wsClients.length = 0
  observed.requests.length = 0
  observed.tenantToken = {}
}

/**
 * Region selector accepted by `Client`/`WSClient`.
 *
 * These are the real values, not names: the SDK ships a numeric enum whose
 * reverse mapping makes `Domain[0] === 'Feishu'`, so a stub answering `'feishu'`
 * would accept a domain used as an origin, and let exactly that ship.
 */
export const Domain = { 0: 'Feishu', 1: 'Lark', Feishu: 0, Lark: 1 }

/**
 * The origins behind those values, as the SDK's `formatDomain` resolves them.
 */
const ORIGINS = { [Domain.Feishu]: 'https://open.feishu.cn', [Domain.Lark]: 'https://open.larksuite.com' }

/**
 * Log level selector. The real values, for the same reason as `Domain`: the SDK
 * compares these numerically, so a stub answering names would accept a level that
 * silences nothing.
 */
export const LoggerLevel = {
  0: 'fatal', 1: 'error', 2: 'warn', 3: 'info', 4: 'debug', 5: 'trace',
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
}

/** Records outbound message calls and returns a stable message id. */
export class Client {
  constructor(config) {
    this.config = config
    // Resolved like the real client, so `client.domain` means here what it means
    // there: an origin, rather than the enum that was passed in.
    this.domain = ORIGINS[config.domain] ?? config.domain
    this.tokenManager = { domain: this.domain }
    this.im = {
      message: {
        create: async (request) => {
          // A case can make the next delivery fail the way the platform refuses
          // an oversized card, which is the only way to exercise the retry.
          if (observed.failNextDelivery !== undefined) {
            const message = observed.failNextDelivery
            observed.failNextDelivery = undefined
            observed.deliveryFailures += 1
            throw new Error(message)
          }
          observed.created.push(request)
          return { data: { message_id: `om_stub_${observed.created.length}` } }
        },
        patch: async (request) => {
          observed.patched.push(request)
          return { data: {} }
        },
      },
    }
  }

  /**
   * The one generic request the channel makes: the tenant-token check.
   *
   * The SDK takes an API path here and owns the origin behind `domain`, so a
   * caller that built a URL itself arrives with something the real client never
   * sends. This refuses that where the mistake is made.
   * @param options - the SDK's request options.
   * @returns the platform's answer, driven by `observed.tenantToken`.
   */
  request(options) {
    if (typeof options?.url !== 'string' || !options.url.startsWith('/')) {
      return Promise.reject(new Error(`the SDK takes an API path, not an origin: ${String(options?.url)}`))
    }
    observed.requests.push(options)
    const answer = observed.tenantToken
    if (answer.throws !== undefined) return Promise.reject(new Error(answer.throws))
    if (answer.code !== undefined) return Promise.resolve({ code: answer.code, msg: answer.msg })
    return Promise.resolve({ code: 0, tenant_access_token: 'stub-tenant-token', expire: 7200 })
  }
}

/**
 * Captures the dispatcher handed to `start`, and answers on the lifecycle
 * callbacks the real client takes in its constructor.
 *
 * The real `start` launches a handshake and resolves on the spot, so the only
 * signal that a connection is usable is the ready callback; this stub keeps that
 * ordering, and lets a case hold or fail the handshake.
 */
export class WSClient {
  constructor(config) {
    this.config = config
    observed.wsClients.push(this)
  }

  start({ eventDispatcher }) {
    observed.started += 1
    observed.dispatcher = eventDispatcher
    if (observed.handshake === 'held') return Promise.resolve()
    if (observed.handshake === 'failed') {
      this.config.onError?.(new Error(observed.handshakeError))
      return Promise.resolve()
    }
    queueMicrotask(() => { this.config.onReady?.() })
    return Promise.resolve()
  }

  getConnectionStatus() {
    return { state: 'connected', reconnectAttempts: 0 }
  }

  close() {
    observed.closed += 1
  }
}

/** Minimal dispatcher: `register` stores handlers; `invoke` flattens like the SDK. */
export class EventDispatcher {
  constructor(params = {}) {
    this.handlers = {}
    // The real dispatcher takes the same logger options the clients do, and logs
    // its own ready line through them.
    observed.dispatcherOptions = params
  }

  register(map) {
    Object.assign(this.handlers, map)
    return this
  }

  unregister() {
    return this
  }

  /**
   * Dispatch one raw event body the way the long connection does.
   *
   * The SDK parses a v2 envelope by merging its `header` and `event` onto the
   * top level and dropping the `event` key, so a handler reads `data.action`
   * rather than `data.event.action`. A test that calls a handler with the raw
   * envelope shape therefore proves nothing about a real click.
   * @param body - the raw envelope, e.g. `{ schema, header, event }`.
   * @returns the registered handler's return value, or `undefined` for an unregistered type.
   */
  async invoke(body) {
    const { header = {}, event = {}, ...rest } = body
    const handler = this.handlers[header.event_type]
    if (handler === undefined) return undefined
    return await handler({ ...rest, ...header, ...event })
  }
}

/**
 * One-click app creation. Publishes the verification link synchronously and
 * stays pending until the test completes or fails it, mirroring the real
 * device-authorization poll.
 * @param options - the SDK's `registerApp` options.
 * @returns a promise the test settles through `observed`.
 */
export function registerApp(options) {
  observed.registerAppCalls.push(options)
  options.onQRCodeReady?.({ url: 'https://open.feishu.cn/page/launcher?user_code=TEST-CODE', expireIn: 600 })
  return new Promise((resolve, reject) => {
    observed.completeRegisterApp = (result) => {
      observed.completeRegisterApp = undefined
      resolve(result)
    }
    observed.failRegisterApp = (error) => {
      observed.failRegisterApp = undefined
      reject(error)
    }
  })
}
