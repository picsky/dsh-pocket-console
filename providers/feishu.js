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

  // One button per row: side by side halves every label, which cuts off the
  // option text the user is choosing between.
  for (const node of view.buttons) {
    elements.push(button(
      node.label,
      BUTTON_TYPES.has(node.tone) ? node.tone : 'default',
      node.payload,
    ))
  }

  for (const [index, form] of view.forms.entries()) {
    elements.push({
      tag: 'form',
      // One request can carry several questions, and a card may not hold two
      // elements of the same name; the input's own name stays `fieldId` so the
      // submitted value arrives under the key the core decodes.
      name: `form_${index}_${form.fieldId}`,
      elements: [
        form.options === undefined
          ? { tag: 'input', name: form.fieldId, placeholder: plainText(messages().answerPlaceholder) }
          : {
              tag: 'checker',
              name: form.fieldId,
              options: form.options.map(option => ({
                text: plainText(option.label),
                value: option.value,
              })),
            },
        // A multi-select question takes a typed answer beside its choices, the
        // pair the desktop card offers; one submit carries both names.
        ...(form.customFieldId === undefined
          ? []
          : [{ tag: 'input', name: form.customFieldId, placeholder: plainText(messages().notePlaceholder) }]),
        {
          ...button(form.submitLabel, 'primary', form.payload),
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
  const dispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data) => {
      const action = data?.action
      // A card is a capability: whoever holds the message can press its buttons.
      // Only the bound recipient's press counts, so a forwarded card or a
      // shoulder-surfer cannot answer on the pair's behalf — the answer the core
      // injects is human-attributed input.
      const sender = data?.operator?.open_id
      const bound = (await recipient().catch(() => undefined))?.id
      if (typeof sender !== 'string' || sender === '' || sender !== bound) {
        log.debug('忽略非接收人的卡片操作。')
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
      // A direct message is the user asking to be reachable here. Re-binding is
      // how a changed device or account recovers without editing configuration.
      const openId = data?.sender?.sender_id?.open_id
      if (typeof openId !== 'string' || openId === '') return
      if (await binding.read() === openId) return
      await binding.write(openId)
      log.info(`绑定接收人：${openId}`)
    },
  })

  /** Set by the core before any interaction can arrive. */
  let onAction

  /** Enrollment progress for the Settings card. Never carries a secret. */
  let enrollment = { state: 'unbound' }

  /** The one in-flight onboarding run, shared across callers. */
  let onboarding

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
    log.info(`请在手机上打开以下链接完成飞书绑定（${info.expireIn} 秒内有效，仅可使用一次）：`)
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
    return storedId?.value !== undefined && storedSecret?.value !== undefined
      ? { appId: storedId.value, appSecret: storedSecret.value }
      : undefined
  }

  /**
   * Create the application through the one-click flow and persist it.
   * @param run - the generation that started this run.
   * @returns the created credentials, whether or not they were persisted.
   */
  const createApplication = async (run, { createOnly = config.createOnly } = {}) => {
    log.info('未找到飞书凭据，开始一键创建应用；请用飞书扫描或打开下面的链接。')
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
      onStatusChange: (info) => { log.info(`绑定状态：${info.status}`) },
    })

    // The scan outlives the request that started it, so the user may have
    // unbound while this was pending; the credentials are then nobody's to keep.
    if (run !== generation) return { appId: result.client_id, appSecret: result.client_secret }

    await ctx.credentials.set(appIdRef, result.client_id)
    await ctx.credentials.set(appSecretRef, result.client_secret)
    const openId = result.user_info?.open_id
    if (typeof openId === 'string' && openId !== '') await binding.write(openId)
    log.info(`飞书应用已创建：${result.client_id}`)

    return { appId: result.client_id, appSecret: result.client_secret }
  }

  /**
   * Connect the long connection.
   * @param run - the generation that owns this attempt.
   * @param options - whether a run without stored credentials may create one.
   * @returns whether a transport is connected.
   */
  const connect = async (run, { allowCreate = true, createOnly } = {}) => {
    const stored = await storedCredentials()
    if (stored === undefined && !allowCreate) {
      // Nothing to resume from. Onboarding belongs to the user's click, not to
      // every boot, so this leaves the state alone instead of offering a scan.
      enrollment = { state: 'unbound' }
      return false
    }
    enrollment = { state: 'starting' }
    credentials = stored ?? await createApplication(run, { createOnly })
    if (closed || run !== generation) return false
    const options = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: config.domain,
    }
    const client = new Lark.Client(options)
    const wsClient = new Lark.WSClient(options)
    wsClient.start({ eventDispatcher: dispatcher })
    transport = { client, wsClient }
    enrollment = { state: 'bound', recipient: await binding.read() ?? null }
    log.info('飞书长连接已启动。')
    return true
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
      if (run !== current) return enrollment
      enrollment = {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
      log.warn('飞书通道恢复失败；审批将只保留在桌面', error)
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
   * then resumed from it.
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
    await ctx.credentials.set(appIdRef, appId.trim())
    await ctx.credentials.set(appSecretRef, appSecret.trim())
    log.info('已保存应用凭据，正在连接飞书。')
    return await resume()
  }

  /**
   * Start onboarding at most once and report where it got to. The
   * device-authorization poll outlives the request that asked for it, so the
   * in-flight run is shared instead of restarted per call; a failure clears the
   * slot so the user can retry from the card.
   * @returns the current enrollment state.
   */
  const beginEnrollment = () => {
    const run = generation
    onboarding ??= connect(run, { createOnly: config.createOnly }).catch((error) => {
      // A cancelled run must not publish its failure over the enrollment that
      // replaced it, nor clear a retry the user already started.
      if (run !== generation) return
      enrollment = {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
      log.warn('飞书绑定失败；审批将只保留在桌面', error)
      onboarding = undefined
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
    available: () => transport !== undefined,
    enrollmentState: () => enrollment,
    beginEnrollment,
    adoptCredentials,
    resume,
    async clearEnrollment() {
      // Retire the running onboarding first: everything it would still write
      // belongs to an enrollment the user has just cancelled.
      generation += 1
      try {
        transport?.wsClient?.close?.()
      } catch (error) {
        log.warn('飞书长连接关闭失败', error)
      }
      transport = undefined
      credentials = undefined
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
    async deliver(view) {
      await onboarding
      if (transport === undefined) throw new Error('feishu channel is not connected')
      const { id, type } = await recipient()
      const response = await transport.client.im.message.create({
        params: { receive_id_type: type },
        data: {
          receive_id: id,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(view, messages)),
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
      try {
        transport?.wsClient?.close?.()
      } catch (error) {
        log.warn('飞书长连接关闭失败', error)
      }
    },
  }
}
