/**
 * Feishu (Lark) channel for pocket-console.
 *
 * Onboarding is a single scan. With no stored credentials this provider starts
 * the official one-click app creation flow (`lark.registerApp`, OAuth 2.0
 * Device Authorization Grant), publishes a verification link for the Settings
 * card, and once the user confirms, stores the App ID, the App Secret, and the
 * scanning user's `open_id` in the harness credential store. No developer
 * console work, no credential copying, and no id hunting.
 *
 * Delivery and interaction run over the SDK's WebSocket long connection, so the
 * host only needs outbound network access.
 *
 * @module pocket-console/providers/feishu
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Channel name used in diagnostics. */
export const name = 'feishu'

/**
 * Application-identity scopes this channel requests. The minimal base preset
 * (`addons.preset: false`) contributes the Bot capability; this list adds only
 * what approval delivery needs.
 */
const TENANT_SCOPES = [
  /** Send the approval card. */
  'im:message:send_as_bot',
  /** Rewrite the card once a decision exists. */
  'im:message:update',
  /** Read the direct message that confirms or refreshes a binding. */
  'im:message.p2p_msg:readonly',
]

/** Events this channel subscribes to. */
const TENANT_EVENTS = ['im.message.receive_v1']

/** Callbacks this channel subscribes to. Button presses arrive here. */
const CALLBACKS = ['card.action.trigger']

/** Button styles Feishu accepts. */
const BUTTON_TYPES = new Set(['default', 'primary', 'danger'])

/** Header templates per channel-neutral tone. */
const TEMPLATES = {
  warning: 'orange',
  info: 'blue',
  success: 'green',
  danger: 'red',
  muted: 'grey',
}

/** How long a credential check may take before it reads as an unreachable platform. */
const CREDENTIAL_CHECK_TIMEOUT_MS = 10_000

/**
 * The endpoint that issues a tenant token for an app id and secret. The SDK takes
 * it as a path: it owns the origin behind `Domain.Feishu` and `Domain.Lark`.
 */
const TENANT_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

/**
 * How long a wait may last before the card says it is taking unusually long —
 * either a handshake or the round trip that returns the scan's QR code. The work
 * keeps running; this only stops a slow attempt from looking like a stuck card.
 */
const CONNECTION_SLOW_MS = 30_000

/**
 * Feishu's own codes for a rejected pair, where the meaning is one the card has
 * words for. Codes are listed only when the platform's answer for them was
 * observed; anything else keeps the platform's message.
 */
const REJECTION_CODES = new Map([[10014, 'wrongAppId']])

/** The platform's wording for each half of a rejected pair. */
const REJECTION_WORDS = [
  [/app[ _-]?id/i, 'wrongAppId'],
  [/secret|密钥/i, 'wrongAppSecret'],
]

/**
 * Race one request against a deadline.
 * @param request - the pending request.
 * @param milliseconds - how long it may take.
 * @param message - what to fail with when it does not answer in time.
 * @returns the request's value.
 */
async function withDeadline(request, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      request,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(message)) }, milliseconds)
        // A pending check must not be the reason the process stays up.
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The platform's own answer inside an SDK error message.
 *
 * The SDK formats a call it could not authenticate as
 * `failed to get tenant_access_token, code: 10014, msg: app id not exists`, which
 * is the reason worth showing and the only place it appears.
 */
const REJECTION_IN_MESSAGE = /code:\s*(\d+)\s*,\s*msg:\s*([^,]+)/

/**
 * The SDK's own wording when it could not authenticate the pair.
 *
 * This is what separates a refusal from any other failure that happens to carry
 * a `code`/`msg` pair: the credentials are only discarded on a refusal, so the
 * classification has to rest on evidence the platform produced.
 */
const SDK_AUTH_FAILURE = /failed to get tenant_access_token/i

/**
 * The SDK's log, routed into this deployment's log.
 *
 * The SDK prints a startup banner and a line per connection step at info level,
 * which is noise in a running deployment: what is worth reading there is its
 * errors and warnings. Levels decide where each message lands — the SDK's info and
 * debug become deployment debug — so the deployment's own level governs how much of
 * it anyone reads, instead of every deployment being told.
 * @param log - this plugin's log.
 * @returns the logger the SDK takes in its client options.
 */
function sdkLogger(log) {
  /** One SDK message: the SDK hands its parts over as an array. */
  const text = (parts) => parts
    .flat(Infinity)
    .map((part) => {
      if (typeof part === 'string') return part
      if (part instanceof Error) return part.message
      try {
        return JSON.stringify(part)
      } catch {
        // A value that cannot be serialized is still worth naming.
        return String(part)
      }
    })
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')

  const route = (emit) => (...parts) => { emit(`飞书 SDK：${text(parts)}`) }
  return {
    error: route((message) => { log.warn(message) }),
    warn: route((message) => { log.warn(message) }),
    info: route((message) => { log.debug(message) }),
    debug: route((message) => { log.debug(message) }),
    trace: route((message) => { log.debug(message) }),
  }
}

/**
 * The card's words for a pair the platform rejected.
 * @param copy - the deployment's copy table.
 * @param body - the platform's answer, carrying `code` and `msg`.
 * @returns the reason to show.
 */
function rejectionReason(copy, body) {
  const named = REJECTION_CODES.get(body?.code)
  if (named !== undefined) return copy[named]
  const words = typeof body?.msg === 'string' ? body.msg : ''
  for (const [pattern, key] of REJECTION_WORDS) {
    if (pattern.test(words)) return copy[key]
  }
  return words === '' ? copy.credentialRejected : `${copy.credentialRejected}（${words}）`
}

/**
 * Ask the platform whether an app id and secret are usable.
 *
 * The long connection cannot answer this. Its handshake retries a pair the
 * platform rejects instead of failing, so a deployment bound to a wrong secret
 * would sit at "connecting" forever with nothing to report. This endpoint takes
 * the pair directly — the same pair the connection authenticates with — and
 * answers with a code and a reason.
 *
 * The call goes through the SDK's own client rather than a URL built here:
 * `domain` is the SDK's enum (`Domain.Feishu` is 0), not an origin, and the
 * client is what turns it into the platform to ask.
 * @param client - the SDK client for these credentials.
 * @param credentials - the app id and secret to check.
 * @param copy - the copy for a rejection, and for a platform that cannot be reached.
 * @returns whether the pair works, and why not when it does not.
 */
async function checkCredentials(client, credentials, copy) {
  let body
  try {
    body = await withDeadline(client.request({
      method: 'POST',
      url: TENANT_TOKEN_PATH,
      data: { app_id: credentials.appId, app_secret: credentials.appSecret },
    }), CREDENTIAL_CHECK_TIMEOUT_MS, copy.platformUnreachable)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const refusal = REJECTION_IN_MESSAGE.exec(message)
    // Only a real refusal may be called one: a rejected pair is discarded from
    // the store, so a proxy or gateway that happens to echo `code: …, msg: …`
    // must not be able to delete credentials that work. The SDK says which call
    // it could not authenticate, and the platform codes it is known to answer
    // with are the other half of the evidence.
    const named = refusal === null ? undefined : REJECTION_CODES.get(Number(refusal[1]))
    if (refusal !== null
      && (named !== undefined || SDK_AUTH_FAILURE.test(message))) {
      return {
        ok: false,
        kind: 'rejected',
        message: rejectionReason(copy, { code: Number(refusal[1]), msg: refusal[2].trim() }),
      }
    }
    // A platform that cannot be reached and a request that never answered read
    // the same way to the reader: this pair could not be checked.
    return { ok: false, kind: 'unreachable', message: copy.unreachableWith(message) }
  }
  const answer = body?.data ?? body
  if (answer?.code !== undefined && answer.code !== 0) {
    return { ok: false, kind: 'rejected', message: rejectionReason(copy, answer) }
  }
  return { ok: true }
}

/**
 * Apply documented defaults to the raw channel configuration.
 * @param raw - `channelConfig` from the plugin entry.
 * @returns the resolved settings.
 */
function resolveConfig(raw, messages) {
  const config = raw ?? {}
  return {
    appIdRef: config.appIdRef ?? 'DSH_FEISHU_APP_ID',
    appSecretRef: config.appSecretRef ?? 'DSH_FEISHU_APP_SECRET',
    domain: config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    receiveId: config.receiveId,
    receiveIdType: config.receiveIdType ?? 'open_id',
    appName: config.appName ?? 'DSH Pocket Console',
    appDesc: config.appDesc ?? messages().appDescription,
    createOnly: config.createOnly ?? true,
  }
}

/** One plain-text card node. */
const plainText = (content) => ({ tag: 'plain_text', content })

/** One callback button bound to the given payload. */
const button = (label, tone, payload) => ({
  tag: 'button',
  text: plainText(label),
  type: tone,
  width: 'fill',
  behaviors: [{ type: 'callback', value: payload }],
})

/**
 * Render one channel-neutral view as a card JSON 2.0 document.
 * @param view - the view built by the core.
 * @returns the card document.
 */
function renderCard(view, messages) {
  const elements = view.body.map(content => ({ tag: 'markdown', content }))

  // A folded record, where the view carries one. Collapsed by default and opened in place by the
  // client: the reader who wants the whole of a finished run asks for it, and the reader who does
  // not is not made to scroll past it.
  //
  // A rule is drawn above it because the panel's own header is the only thing the platform will
  // render for a collapsed fold — a header is one line with a chevron, and the client decides what
  // that looks like. Without a rule the panel reads as one more paragraph of the card rather than as
  // a separate section, which is how a reader ends up not realising it can be opened at all.
  if (view.details !== undefined) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'markdown', content: `**${view.details.title}**` } },
      elements: view.details.blocks.map(content => ({ tag: 'markdown', content })),
    })
  }

  // One button per row: side by side halves every label, which cuts off the
  // option text the user is choosing between.
  for (const node of view.buttons) {
    elements.push(button(
      node.label,
      BUTTON_TYPES.has(node.tone) ? node.tone : 'default',
      node.payload,
    ))
  }

  // A card may not hold two elements of the same name. The core names a form's controls
  // `value` and `custom` on every form, because a form answers one question, so a card
  // carrying two forms would repeat both names and the platform would refuse the whole
  // card — which reaches the reader as no message at all, with only a delivery warning
  // in the log to show for it. The core sends one question per view and so never builds
  // such a card; the namespacing stays because this renderer must be correct for any
  // view it is handed. The submit carries the mapping back so the core knows what to read.
  for (const [index, form] of view.forms.entries()) {
    const name = (field) => `form_${index}_${field}`
    const submits = Object.fromEntries(
      [form.fieldId, form.customFieldId]
        .filter(field => field !== undefined)
        .map(field => [field, name(field)]),
    )
    elements.push({
      tag: 'form',
      name: `form_${index}`,
      elements: [
        form.options === undefined
          ? {
              tag: 'input',
              name: name(form.fieldId),
              // A view may name its own placeholder, which matters when two forms share one card:
              // the answer box and the next-task box ride the same result card, and a shared
              // placeholder would make them read as the same control.
              placeholder: plainText(form.placeholder ?? messages().answerPlaceholder),
            }
          : {
              tag: 'checker',
              name: name(form.fieldId),
              options: form.options.map(option => ({
                text: plainText(option.label),
                value: option.value,
              })),
            },
        // A multi-select question takes a typed answer beside its choices, the
        // pair the desktop card offers; one submit carries both names.
        ...(form.customFieldId === undefined
          ? []
          : [{ tag: 'input', name: name(form.customFieldId), placeholder: plainText(messages().notePlaceholder) }]),
        {
          ...button(form.submitLabel, 'primary', { ...form.payload, submits }),
          form_action_type: 'submit',
        },
      ],
    })
  }

  return {
    schema: '2.0',
    // A shared card is required for the post-decision rewrite.
    config: { update_multi: true },
    header: { template: TEMPLATES[view.tone] ?? 'blue', title: plainText(view.title) },
    body: { elements },
  }
}

/**
 * Create the Feishu channel.
 * @param context - core-provided host: `ctx`, resolved `config`, `binding`, `log`.
 * @returns the channel contract this core consumes.
 */
export async function create({ ctx, config: rawConfig, binding, log, messages }) {
  const config = resolveConfig(rawConfig, messages)
  const appIdRef = credentialRef(config.appIdRef)
  const appSecretRef = credentialRef(config.appSecretRef)

  /** Live credentials, absent until the one-click flow completes. */
  let credentials
  /** Ready transport pair, absent until credentials exist. */
  let transport
  let closed = false

  // A handler receives its parsed event body: the SDK merges a v2 envelope's
  // `header` and `event` onto the top level and drops the `event` key, so the
  // action fields live at `data.action`. Reading the envelope's own nesting
  // finds no payload, and every click then decodes as an expired request.
  // Everything the SDK logs goes through this: its startup banner, its event
  // dispatcher's ready line, and every connection step are debug here, so a
  // running deployment does not read them while its errors and warnings still
  // arrive. One adapter, so the routing cannot differ between the SDK's objects.
  const sdkLog = sdkLogger(log)

  const dispatcher = new Lark.EventDispatcher({
    logger: sdkLog,
    loggerLevel: Lark.LoggerLevel.debug,
  }).register({
    'card.action.trigger': async (data) => {
      const action = data?.action
      // A card is a capability: whoever holds the message can press its buttons.
      // Only the bound recipient's press counts, so a forwarded card or a
      // shoulder-surfer cannot answer on the pair's behalf — the answer the core
      // injects is human-attributed input.
      const sender = data?.operator?.open_id
      const bound = (await recipient().catch(() => undefined))?.id
      if (typeof sender !== 'string' || sender === '' || sender !== bound) {
        log.debug(messages().logNotRecipient)
        return { toast: { type: 'warning', content: messages().notRecipient } }
      }
      const settled = await onAction?.({
        payload: action?.value,
        values: action?.form_value,
        messageId: data?.context?.open_message_id,
        sender,
      })
      if (settled === undefined) return { toast: { type: 'warning', content: messages().requestExpired } }
      return { toast: { type: settled.accepted ? 'success' : 'warning', content: settled.toast } }
    },
    'im.message.receive_v1': async (data) => {
      // A *direct* message is the user asking to be reachable here. A group
      // message is not: the bot can be in a group it was added to, and the
      // sender of a group message has not identified themselves as this
      // deployment's operator. Taking one would hand the recipient — and so
      // every approval card, and the authority to press its buttons — to
      // whoever spoke in that group.
      if (data?.message?.chat_type !== 'p2p') return
      const openId = data?.sender?.sender_id?.open_id
      if (typeof openId !== 'string' || openId === '') return
      const current = await binding.read()
      if (current === openId) return
      // A direct message is consent to be reachable here, so it binds an
      // unbound deployment. It must not *re-bind* a bound one: the sender is
      // whoever can reach the bot, and accepting them would hand the recipient
      // — and with it every approval card, and the authority to answer one —
      // to a stranger. Changing the recipient is the Settings card's job, where
      // it is a deliberate act.
      if (current !== undefined && current !== '') {
        log.warn(messages().logRecipientKept)
        return
      }
      await binding.write(openId)
      // The card is polling for exactly this: a message the user just sent is
      // what binds them, and the card must stop asking for one.
      if (enrollment.state === 'bound') enrollment = { ...enrollment, recipient: openId }
      log.info(messages().logRecipientBound(openId))
    },
  })

  /** Set by the core before any interaction can arrive. */
  let onAction

  /** Enrollment progress for the Settings card. Never carries a secret. */
  let enrollment = { state: 'unbound' }

  /** The one in-flight onboarding run, shared across callers. */
  let onboarding

  /**
   * Whether this deployment is known to hold app credentials.
   *
   * Set by the read that onboarding and resume already perform. It exists so the
   * stage a click publishes synchronously is the right one: the store read is
   * asynchronous, and a click that answered `creating` for a deployment that is
   * merely reconnecting would name the wrong wait.
   */
  let credentialsStored = false

  /** Whether the long connection has completed a handshake. */
  let connected = false

  /** Pending notice that a handshake is taking unusually long. */
  let slowTimer

  /**
   * What the current connection could not do, reported beside its state: a pair
   * the user typed that the store refused to keep.
   */
  let persistNotice

  /** Stop the pending slowness notice, if one is armed. */
  const clearSlow = () => {
    clearTimeout(slowTimer)
    slowTimer = undefined
  }

  /** Drop the live pair. Whatever connects next opens its own. */
  const closeTransport = () => {
    clearSlow()
    connected = false
    try {
      transport?.wsClient?.close?.()
    } catch (error) {
      log.warn(messages().logTransportCloseFailed, error)
    }
    transport = undefined
  }

  /**
   * Publish the bound state, reading the recipient as it stands now.
   * @param run - the generation that owns this connection.
   * @param extra - what the attempt could not do, when it could not do it.
   */
  const publishBound = async (run, extra = {}) => {
    const recipient = await binding.read().catch(() => undefined)
    if (closed || run !== generation) return
    enrollment = {
      state: 'bound',
      appId: credentials?.appId,
      recipient: recipient ?? null,
      connected,
      ...persistNotice,
      ...extra,
    }
  }

  /**
   * Publish the bound state for one connection, without letting a failure to
   * read the recipient end the callback that reported readiness.
   * @param run - the generation that owns this connection.
   * @param extra - what the attempt could not do, when it could not do it.
   */
  const republish = (run, extra) => {
    void publishBound(run, extra).catch((error) => { log.warn(messages().logPublishFailed, error) })
  }

  /**
   * Bumped when the binding is cleared. An onboarding run captures it, so a scan
   * that settles after an unbind writes nothing back: without it, a late success
   * re-creates the credentials and the recipient the user just removed.
   */
  let generation = 0

  /**
   * Publish the verification link and record it for the Settings card, which
   * renders it as a QR code. The link is single-use and expires, so it is not
   * a secret worth persisting.
   * @param info - the SDK's ready payload.
   */
  const announce = (info) => {
    enrollment = { state: 'awaiting', verifyUrl: info.url, expiresIn: info.expireIn }
    log.info(messages().logOpenLink(info.expireIn))
    log.info(info.url)
  }

  /**
   * The credentials the store already holds, or undefined for a first run.
   * @returns the stored app id and secret.
   */
  const storedCredentials = async () => {
    const [storedId, storedSecret] = await Promise.all([
      ctx.credentials.resolve(appIdRef),
      ctx.credentials.resolve(appSecretRef),
    ])
    const pair = storedId?.value !== undefined && storedSecret?.value !== undefined
      ? { appId: storedId.value, appSecret: storedSecret.value }
      : undefined
    // The one read that knows: remembered so the next click can name its wait
    // without waiting for a read of its own.
    credentialsStored = pair !== undefined
    return pair
  }

  /**
   * Create the application through the one-click flow and persist it.
   * @param run - the generation that started this run.
   * @returns the created credentials, whether or not they were persisted.
   */
  const createApplication = async (run, { createOnly = config.createOnly } = {}) => {
    log.info(messages().logNoCredentials)
    const result = await Lark.registerApp({
      appPreset: { name: config.appName, desc: config.appDesc },
      addons: {
        // Minimal base: the Bot capability and nothing else, then exactly the
        // scopes this channel uses.
        preset: false,
        scopes: { tenant: TENANT_SCOPES },
        events: { items: { tenant: TENANT_EVENTS } },
        callbacks: { items: CALLBACKS },
      },
      createOnly,
      onQRCodeReady: announce,
      onStatusChange: (info) => { log.info(messages().logBindStatus(info.status)) },
    })

    // The scan outlives the request that started it, so the user may have
    // unbound while this was pending; the credentials are then nobody's to keep.
    if (run !== generation) return { appId: result.client_id, appSecret: result.client_secret }

    await ctx.credentials.set(appIdRef, result.client_id)
    await ctx.credentials.set(appSecretRef, result.client_secret)
    const openId = result.user_info?.open_id
    if (typeof openId === 'string' && openId !== '') await binding.write(openId)
    log.info(messages().logAppCreated(result.client_id))

    return { appId: result.client_id, appSecret: result.client_secret }
  }

  /**
   * The lifecycle callbacks one connection attempt publishes through.
   *
   * Readiness is published here rather than by `start()`. `start` launches a
   * handshake and resolves on the spot, and a handshake the platform rejects for
   * bad credentials is retried instead of surfaced — so the ready callback is
   * the first moment this channel can actually receive, and the error callback
   * is the only terminal failure it reports.
   * @param run - the generation that owns this attempt.
   * @returns the callbacks for the SDK's WebSocket client.
   */
  const lifecycle = (run) => ({
    onReady: () => {
      if (closed || run !== generation) return
      clearSlow()
      connected = true
      republish(run)
      log.info(messages().logReady)
    },
    onReconnecting: () => {
      if (closed || run !== generation) return
      connected = false
      republish(run)
      log.warn(messages().logDisconnected)
    },
    onReconnected: () => {
      if (closed || run !== generation) return
      connected = true
      republish(run)
      log.info(messages().logReconnected)
    },
    onError: (error) => {
      if (closed || run !== generation) return
      connected = false
      const reason = error instanceof Error ? error.message : String(error)
      enrollment = { state: 'failed', message: messages().connectionFailed(reason) }
      // A terminal error is the end of this attempt, so its connection is given up
      // with it. Holding the dead transport would make the card's own retry a no-op:
      // `beginEnrollment` treats a live transport as work already done and returns
      // the failure it was asked to replace, so the button would do nothing.
      closeTransport()
      log.warn(messages().logConnectionFailed, error)
    },
  })

  /**
   * Connect the long connection.
   * @param run - the generation that owns this attempt.
   * @param options - what this attempt may do and what it carries: whether a run
   *   without stored credentials may create one, credentials to use instead of
   *   the stored ones, and whether those came from the user typing them.
   * @returns the enrollment state after the attempt.
   */
  const connect = async (run, { allowCreate = true, createOnly, credentials: entered, fromUserInput } = {}) => {
    const stored = entered ?? await storedCredentials()
    if (stored === undefined && !allowCreate) {
      // Nothing to resume from. Onboarding belongs to the user's click, not to
      // every boot, so this leaves the state alone instead of offering a scan.
      enrollment = { state: 'unbound' }
      return enrollment
    }
    // Which wait this is: the QR code arrives a network round trip after the
    // click, so a run that has to create the app says so instead of looking like
    // a connection that is already under way.
    enrollment = { state: 'starting', stage: stored === undefined ? 'creating' : 'connecting' }
    credentials = stored ?? await createApplication(run, { createOnly })
    if (closed || run !== generation) return enrollment

    const options = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: config.domain,
      logger: sdkLog,
      loggerLevel: Lark.LoggerLevel.debug,
    }
    const client = new Lark.Client(options)

    // Bad credentials are the one failure the connection cannot report: its
    // handshake retries them instead of failing. Asking the platform directly is
    // what turns that silence into a reason the card can show.
    const check = await checkCredentials(client, credentials, messages())
    if (closed || run !== generation) return enrollment
    if (!check.ok) {
      enrollment = { state: 'failed', message: check.message }
      log.warn(messages().logCredentialsRejected(check.message))
      // A pair the user just typed and the platform rejects is not worth
      // keeping: a later boot would retry it and report the same failure with
      // nobody having asked. An unreachable platform proves nothing, so it
      // keeps whatever was entered.
      if (fromUserInput === true && check.kind === 'rejected') {
        await ctx.credentials.unset(appIdRef)
        await ctx.credentials.unset(appSecretRef)
      }
      return enrollment
    }

    const wsClient = new Lark.WSClient({ ...options, ...lifecycle(run) })
    connected = false
    // What this connection expects to receive, said out loud once. Two names have to agree for a
    // button press to arrive: the callback the app was created subscribed to, and the key the
    // dispatcher below is registered under. They are separate strings in separate places, and a
    // drift between them is silent in the worst way — every card still renders with its buttons, and
    // pressing one simply does nothing, with no error on either side. Logging both makes that a
    // comparison a deployment can make from its own log instead of a guess. The same line answers
    // "is the long connection even subscribed to the thing I am pressing".
    log.info(messages().logSubscribedCallbacks(CALLBACKS.join(', ')))
    log.info(messages().logSubscribedEvents(TENANT_EVENTS.join(', ')))
    // Published before the handshake is asked for, because the callbacks that report
    // it can run synchronously inside `start()` — an error arrives there, and the
    // handler has to be able to give this connection up. Assigning afterwards meant
    // the failure closed nothing and then the dead pair was stored anyway, which is
    // what made the card's retry a no-op.
    transport = { client, wsClient }
    // Armed before the handshake starts: a connection that reports itself ended
    // must be able to clear a notice that has not fired yet.
    slowTimer = setTimeout(() => {
      // A QR code that already landed is not a slow connection, so only a run that
      // is still waiting is marked — and it keeps the stage it was waiting in.
      if (closed || run !== generation || connected || enrollment.state !== 'starting') return
      enrollment = { ...enrollment, slow: true }
    }, CONNECTION_SLOW_MS)
    slowTimer.unref?.()
    try {
      wsClient.start({ eventDispatcher: dispatcher })
    } catch (error) {
      // A `start` that throws must not leave the pair behind either.
      closeTransport()
      throw error
    }
    log.info(messages().logConnecting)
    return enrollment
  }

  /**
   * Reconnect from stored credentials without onboarding.
   *
   * Credentials and recipient are persisted, so a restart must not need the
   * Settings card to deliver anything. A deployment with nothing stored stays
   * unbound and is left to the card.
   * @returns the enrollment state after the attempt.
   */
  const resume = async () => {
    if (transport !== undefined || onboarding !== undefined) return enrollment
    const run = generation
    try {
      await connect(run, { allowCreate: false })
    } catch (error) {
      if (run !== generation) return enrollment
      enrollment = {
        state: 'failed',
        // The card renders this verbatim, so it is copy, not an SDK string.
        message: messages().connectionFailed(error instanceof Error ? error.message : String(error)),
      }
      log.warn(messages().logResumeFailed, error)
    }
    return enrollment
  }

  /**
   * Adopt an app the user already has, by the credentials that name it.
   *
   * This is the whole "bind an existing bot" story: the app id and secret are
   * exactly what the channel connects with, so nothing has to be authorized
   * through a page, and nothing polls. The pair is written to the credential
   * store — the same place the one-click flow writes it — and the connection is
   * then opened with it.
   * @param credentials - the app id and secret the user pasted from the console.
   * @returns the enrollment state after the attempt.
   */
  const adoptCredentials = async ({ appId, appSecret }) => {
    if (typeof appId !== 'string' || appId.trim() === ''
      || typeof appSecret !== 'string' || appSecret.trim() === '') {
      throw new Error('an app id and an app secret are both required')
    }
    // A scan may be mid-flight; it belongs to a request the user has moved on
    // from, and its credentials would overwrite what was just entered.
    generation += 1
    onboarding = undefined
    // Whatever the card was showing belongs to the attempt being replaced: a
    // verification link must not keep offering a scan for an app the user has
    // just moved on from.
    enrollment = { state: 'starting' }
    // A connection belongs to the credentials it was opened with. Keeping it
    // would leave the previous app receiving while the card named the new one.
    closeTransport()
    // The recipient belongs to the app it was learned from: Feishu scopes an
    // `open_id` to the app that resolved it, so the id stored for the previous
    // app addresses nobody under this one. What is left is an unbound
    // deployment, and the card says so instead of naming a recipient that can
    // never receive anything.
    const hadRecipient = await binding.read() !== undefined
    if (hadRecipient && config.receiveId === undefined) await binding.clear()
    const entered = { appId: appId.trim(), appSecret: appSecret.trim() }
    // The store can refuse the pair: a deployment whose environment carries the
    // same reference shadows it, and a read-only document cannot be written.
    // What was typed still connects this session; only keeping it is lost, and
    // the card says so.
    let persistWarning
    try {
      await ctx.credentials.set(appIdRef, entered.appId)
      await ctx.credentials.set(appSecretRef, entered.appSecret)
    } catch (error) {
      persistWarning = {
        persisted: false,
        persistError: error instanceof Error ? error.message : String(error),
      }
      log.warn(messages().logPersistFailed, error)
    }
    persistNotice = persistWarning
    log.info(messages().logAdopting)
    return await connect(generation, {
      allowCreate: false,
      credentials: entered,
      fromUserInput: true,
    })
  }

  /**
   * Start onboarding at most once and report where it got to. The
   * device-authorization poll outlives the request that asked for it, so the
   * in-flight run is shared instead of restarted per call; a failure clears the
   * slot so the user can retry from the card.
   *
   * The wait is published before the run starts, because `connect` cannot say
   * anything until its first await has resolved — the click would otherwise answer
   * with the state it is replacing, and the card would show no sign of the work
   * until the QR code arrived. Reading the store first costs one local read and
   * says which wait this is: creating the app, or connecting to one it already has.
   * @returns a promise of the state after the wait was published.
   */
  const beginEnrollment = async () => {
    const run = generation
    // A live transport is the work already done: starting another would open a
    // second connection to the same app and leave the first one running.
    if (transport !== undefined || onboarding !== undefined) return enrollment
    // The run is claimed before the first await. Reading the store suspends, and
    // two clicks that both suspended would both see no run in flight — then both
    // create an app, and the second transport replaces the first without closing
    // it, leaving a live connection nothing holds a reference to. The stage is
    // published synchronously for the same reason: the click must never answer
    // with the state it is replacing.
    const had = credentialsStored
    enrollment = { state: 'starting', stage: had ? 'connecting' : 'creating' }
    onboarding = (async () => {
      const stored = await storedCredentials()
      if (run !== generation) return enrollment
      credentialsStored = stored !== undefined
      // The read is the authority: a deployment that lost its credentials since
      // the last look is creating an app after all.
      enrollment = { ...enrollment, stage: stored === undefined ? 'creating' : 'connecting' }
      return await connect(run, { createOnly: config.createOnly, credentials: stored })
    })().catch((error) => {
      // A cancelled run must not publish its failure over the enrollment that
      // replaced it, nor clear a retry the user already started.
      if (run !== generation) return enrollment
      enrollment = {
        state: 'failed',
        message: messages().connectionFailed(error instanceof Error ? error.message : String(error)),
      }
      log.warn(messages().logEnrollmentFailed, error)
      return enrollment
    }).finally(() => {
      // The slot is free again once this run has settled, so a retry starts a
      // new one instead of returning the state of the attempt that just failed.
      if (onboarding !== undefined && run === generation) onboarding = undefined
    })
    return enrollment
  }

  /** Recipient resolution: explicit configuration wins, else the stored binding. */
  const recipient = async () => {
    if (config.receiveId !== undefined && config.receiveId !== '') {
      return { id: config.receiveId, type: config.receiveIdType }
    }
    const id = await binding.read()
    if (id === undefined) throw new Error('no bound recipient')
    return { id, type: config.receiveIdType }
  }

  return {
    // Forms need a checker/input component; the SDK and cards support them.
    supportsForms: true,
    // Only a connection that completed its handshake can receive a press, so
    // only that connection may take an escalation: the mobile half is useless
    // without the return path, and escalating to it would stall the request.
    available: () => transport !== undefined && connected,
    enrollmentState: () => enrollment,
    beginEnrollment,
    adoptCredentials,
    resume,
    async clearEnrollment() {
      // Retire the running onboarding first: everything it would still write
      // belongs to an enrollment the user has just cancelled.
      generation += 1
      closeTransport()
      credentials = undefined
      persistNotice = undefined
      onboarding = undefined
      await ctx.credentials.unset(appIdRef)
      await ctx.credentials.unset(appSecretRef)
      await binding.clear()
      enrollment = { state: 'unbound' }
      return enrollment
    },
    subscribe(handler) {
      onAction = handler
      return () => { onAction = undefined }
    },
    /**
     * Send one card.
     * @param view - the channel-neutral view to render.
     * @param options - the idempotency key the send should carry, when the caller has one.
     * @returns the message the card lives in.
     */
    async deliver(view, { uuid } = {}) {
      // A pending device-authorization poll can outlive the request that started
      // it, so awaiting it here would hold a delivery for minutes. The core
      // treats a throw as "the desktop keeps this one" — which is the honest
      // answer when the return path is not up yet.
      if (transport === undefined || !connected) throw new Error('feishu channel is not connected')
      const { id, type } = await recipient()
      const response = await transport.client.im.message.create({
        params: { receive_id_type: type },
        data: {
          receive_id: id,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(view, messages)),
          // The platform holds the same key for an hour and answers a repeat with the message it
          // already accepted, so a send whose response was lost is retried without the reader
          // being notified a second time.
          ...(uuid === undefined ? {} : { uuid }),
        },
      })
      return response?.data?.message_id
    },
    async update(handle, view) {
      if (handle === undefined) return
      await transport?.client.im.message.patch({
        path: { message_id: handle },
        data: { content: JSON.stringify(renderCard(view, messages)) },
      })
    },
    close() {
      closed = true
      closeTransport()
    },
  }
}
