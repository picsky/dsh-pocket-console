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
function resolveConfig(raw) {
  const config = raw ?? {}
  return {
    appIdRef: config.appIdRef ?? 'DSH_FEISHU_APP_ID',
    appSecretRef: config.appSecretRef ?? 'DSH_FEISHU_APP_SECRET',
    domain: config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    receiveId: config.receiveId,
    receiveIdType: config.receiveIdType ?? 'open_id',
    appName: config.appName ?? 'DSH 审批助手',
    appDesc: config.appDesc ?? '把 DeepSeek Harness 的工具审批与提问送到飞书',
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

/** Place buttons side by side; Feishu stacks them vertically otherwise. */
const buttonRow = (buttons) => ({
  tag: 'column_set',
  flex_mode: 'bisect',
  horizontal_spacing: '8px',
  columns: buttons.map(node => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [node],
  })),
})

/**
 * Render one channel-neutral view as a card JSON 2.0 document.
 * @param view - the view built by the core.
 * @returns the card document.
 */
function renderCard(view) {
  const elements = view.body.map(content => ({ tag: 'markdown', content }))

  if (view.buttons.length > 0) {
    const nodes = view.buttons.map(node => button(
      node.label,
      BUTTON_TYPES.has(node.tone) ? node.tone : 'default',
      node.payload,
    ))
    // A row holds at most two readable buttons; longer lists stack.
    for (let index = 0; index < nodes.length; index += 2) {
      elements.push(buttonRow(nodes.slice(index, index + 2)))
    }
  }

  for (const form of view.forms) {
    elements.push({
      tag: 'form',
      name: `form_${form.fieldId}`,
      elements: [
        form.options === undefined
          ? { tag: 'input', name: form.fieldId, placeholder: plainText('输入回答') }
          : {
              tag: 'checker',
              name: form.fieldId,
              options: form.options.map(option => ({
                text: plainText(option.label),
                value: option.value,
              })),
            },
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
export async function create({ ctx, config: rawConfig, binding, log }) {
  const config = resolveConfig(rawConfig)
  const appIdRef = credentialRef(config.appIdRef)
  const appSecretRef = credentialRef(config.appSecretRef)

  /** Live credentials, absent until the one-click flow completes. */
  let credentials
  /** Ready transport pair, absent until credentials exist. */
  let transport
  let closed = false

  const dispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': (data) => {
      const value = data?.event?.action?.value
      const settled = onAction?.({
        payload: value,
        values: data?.event?.action?.form_value,
        messageId: data?.event?.context?.open_message_id,
      })
      if (settled === undefined) return { toast: { type: 'warning', content: '该请求已失效' } }
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
   * Resolve stored credentials, or run the one-click creation flow.
   * @returns the credentials to connect with.
   */
  const ensureCredentials = async () => {
    const [storedId, storedSecret] = await Promise.all([
      ctx.credentials.resolve(appIdRef),
      ctx.credentials.resolve(appSecretRef),
    ])
    if (storedId?.value !== undefined && storedSecret?.value !== undefined) {
      return { appId: storedId.value, appSecret: storedSecret.value }
    }

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
      createOnly: config.createOnly,
      onQRCodeReady: announce,
      onStatusChange: (info) => { log.info(`绑定状态：${info.status}`) },
    })

    await ctx.credentials.set(appIdRef, result.client_id)
    await ctx.credentials.set(appSecretRef, result.client_secret)
    const openId = result.user_info?.open_id
    if (typeof openId === 'string' && openId !== '') await binding.write(openId)
    log.info(`飞书应用已创建：${result.client_id}`)

    return { appId: result.client_id, appSecret: result.client_secret }
  }

  /** Connect the long connection once credentials are known. */
  const connect = async () => {
    enrollment = { state: 'starting' }
    credentials = await ensureCredentials()
    if (closed) return
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
  }

  /**
   * Start onboarding at most once and report where it got to. The
   * device-authorization poll outlives the request that asked for it, so the
   * in-flight run is shared instead of restarted per call; a failure clears the
   * slot so the user can retry from the card.
   * @returns the current enrollment state.
   */
  const beginEnrollment = () => {
    onboarding ??= connect().catch((error) => {
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
    async clearEnrollment() {
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
          content: JSON.stringify(renderCard(view)),
        },
      })
      return response?.data?.message_id
    },
    async update(handle, view) {
      if (handle === undefined) return
      await transport?.client.im.message.patch({
        path: { message_id: handle },
        data: { content: JSON.stringify(renderCard(view)) },
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
