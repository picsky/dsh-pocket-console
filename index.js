/**
 * Sends DeepSeek Harness tool approvals and user questions to a phone, so they
 * can be answered from anywhere instead of only at the desk.
 *
 * Both seams are Cordis waterfalls. This plugin registers with `prepend: true`
 * and calls `next()` first: the shipped Web forwarding listener never calls
 * `next()` while a browser is connected, so an escalation answerer registered
 * behind it would never run.
 *
 * This module owns the channel-neutral half: the two answerer seams, the
 * escalation timer, the pending registry, decision decoding, the result
 * notifier, the settings namespace, and the same-origin routes the browser card
 * calls. Transports live behind the channel contract in `providers/README.md`,
 * so adding a channel never edits this file.
 *
 * @module pocket-console
 */

import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { createResultNotifier } from './results.js'

/** Plugin name used by the Loader and every diagnostic. */
export const name = 'pocket-console'

/** Required service: the credential store holds channel secrets and the binding. */
export const inject = ['credentials']

/**
 * Plugin configuration. Channel-neutral values live here; a channel's own
 * settings travel in `channelConfig`, which that module owns and validates
 * because the set differs per transport.
 */
export const Config = z.object({
  /**
   * Channel module. A relative path addresses a local `--patch` overlay; a bare
   * specifier addresses an installed package subpath. Ship a new transport as a
   * new module and point this at it.
   * @default 'dsh-pocket-console/providers/feishu.js'
   */
  channel: z.string().default('dsh-pocket-console/providers/feishu.js'),
  /** Channel-owned settings, passed through untouched. @default {} */
  channelConfig: z.any().default({}),
  /** Seconds the desktop GUI may answer before the channel is used. @default 120 */
  delaySeconds: z.natural().default(120),
  /** Longest rendered reason or question detail, in characters. @default 1200 */
  maxDetailChars: z.natural().default(1200),
  /** Title prefix identifying the deployment. @default 'DSH' */
  titlePrefix: z.string().default('DSH'),
  /**
   * Whether a stopped session's answer is offered to the channel with a box for
   * the next instruction. `'idle'` enables it; `'off'` leaves the channel to
   * live requests only.
   * @default 'off'
   */
  resultNotify: z.union(['off', 'idle']).default('off'),
  /**
   * Seconds before the same session may notify again, so a session running many
   * short turns does not flood the channel.
   * @default 600
   */
  resultNotifyCooldownSeconds: z.natural().default(600),
  /**
   * Seconds a phone decision stays on offer for the browser half to mirror onto
   * the desktop composer. Long enough to cover a page that is already open,
   * short enough that a reloaded page never replays an old answer.
   * @default 60
   */
  mirrorTtlSeconds: z.natural().default(60),
})

/** Approval outcome meaning "this one call may proceed". */
const ALLOW = 'allowed-once'
/** Approval outcome meaning "do not proceed". */
const REJECT = 'rejected'
/** Form field carrying the chosen options, or the typed answer when none are offered. */
const FORM_VALUE_FIELD = 'value'
/** Form field carrying a typed answer beside a multi-select's options. */
const FORM_CUSTOM_FIELD = 'custom'

/** Settings namespace and browser-card slot key; lowercase-hyphenated per the settings grammar. */
const NAME = 'pocket-console'

/** Same-origin route prefix the browser half calls; it never crosses the `/api` fence. */
const ROUTE_PREFIX = '/__pocket'

/** The user-tunable slice of this plugin, surfaced as a Settings card. */
const SectionSchema = z.object({
  /** Seconds the desktop GUI may answer before the channel is used. */
  delaySeconds: z.natural().default(120),
  /** Longest rendered reason or question detail, in characters. */
  maxDetailChars: z.natural().default(1200),
  /** Title prefix identifying the deployment. */
  titlePrefix: z.string().default('DSH'),
  /** Whether a stopped session's answer is offered to the channel. */
  resultNotify: z.union(['off', 'idle']).default('off'),
  /** Seconds before the same session may notify again. */
  resultNotifyCooldownSeconds: z.natural().default(600),
  /** Seconds a phone decision stays on offer for the desktop mirror. */
  mirrorTtlSeconds: z.natural().default(60),
})

/**
 * The escalation target a channel persists for itself, so a user binds once
 * instead of pasting an id into configuration.
 * @param ctx - Host context owning the credential store.
 * @returns read, write, and clear access to this plugin's stored recipient.
 */
function createBinding(ctx) {
  const key = credentialKey(NAME, 'recipient')
  return {
    async read() {
      const record = await ctx.credentials.readRecord(key)
      const payload = record?.kind === 'grant' ? record.payload : undefined
      const id = payload?.id
      return typeof id === 'string' && id !== '' ? id : undefined
    },
    async write(id) {
      await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { id } }))
    },
    async clear() {
      await ctx.credentials.deleteRecord(key)
    },
  }
}

/**
 * Serve the browser half's same-origin state routes.
 *
 * The browser half cannot call a Host Remote method: that surface is generated
 * and the forwarded-event allowlist is host-owned. It uses routes the Host
 * registers on the same webserver that serves the GUI instead — same-origin, so
 * the browser's existing session cookie already applies and no token is needed.
 *
 * These routes are exactly as reachable as the GUI port itself, so every
 * mutating call carries a same-origin check rather than relying on the `/api`
 * trust fence this prefix deliberately sits outside of.
 *
 * @param webServer - the route-registration carrier.
 * @param snapshot - thunk returning the current state for the card.
 * @param actions - mutating operations the card may request.
 * @returns the disposer removing the route.
 */
function registerRoutes(webServer, snapshot, actions) {
  const json = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /** Bound a request body so a malformed caller cannot grow it without limit. */
  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** Reject a cross-site mutation; a browser sends `Origin` on every POST. */
  const sameOrigin = (req) => {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers.host
    if (host === undefined) return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname.slice(ROUTE_PREFIX.length)
      const method = req.method ?? 'GET'
      try {
        if (path === '/state' && method === 'GET') {
          json(res, 200, await snapshot())
          return
        }
        if (path === '/qr.svg' && method === 'GET') {
          // The host renders the code because a browser half shipped without a
          // build step cannot inline a QR encoder; the card only needs an <img>.
          const { enrollment } = await snapshot()
          const url = enrollment?.verifyUrl
          if (typeof url !== 'string') {
            res.writeHead(404)
            res.end()
            return
          }
          const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 })
          res.writeHead(200, {
            'content-type': 'image/svg+xml',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(svg),
          })
          res.end(svg)
          return
        }
        if (method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'cross-origin request refused' })
          return
        }
        if (path === '/bind') {
          await readBody(req)
          json(res, 200, await actions.begin())
          return
        }
        if (path === '/unbind') {
          await readBody(req)
          json(res, 200, await actions.clear())
          return
        }
        if (path === '/mirror' && typeof actions.mirror === 'function') {
          json(res, 200, await actions.mirror(await readBody(req)))
          return
        }
        json(res, 404, { error: 'unknown route' })
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

/**
 * Install the answerers, the channel, and the surfaces around them.
 * @param ctx - Host context; `approval/request` and `user-questions/request` are read here.
 * @param config - validated plugin configuration.
 * @throws when the channel module cannot load, so a misconfigured deployment
 *   fails at load rather than at the first approval.
 */
export async function apply(ctx, config) {
  const log = {
    warn: (message, error) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      ctx.logger?.warn?.(new Error(`pocket-console: ${message}`, { cause: failure }))
    },
    info: (message) => { ctx.logger?.info?.(`pocket-console: ${message}`) },
    /**
     * Routine diagnostics: what the plugin decided and why it skipped. These are
     * frequent by nature — every page load, every panel transition — so they stay
     * out of the deployment log unless the logger is asked for them.
     */
    debug: (message) => { ctx.logger?.debug?.(`pocket-console: ${message}`) },
  }

  // A relative specifier means a local `--patch` overlay; a bare one means an
  // installed package subpath, which Node resolves from the profile.
  const target = config.channel.startsWith('.') || config.channel.startsWith('/')
    ? new URL(config.channel, import.meta.url).href
    : config.channel
  const module = await import(target)
  if (typeof module.create !== 'function') {
    throw new TypeError(`pocket-console: channel ${config.channel} must export create()`)
  }
  const channel = await module.create({
    ctx,
    config: config.channelConfig ?? {},
    binding: createBinding(ctx),
    log,
  })

  // A restart must not need the Settings card. Credentials and recipient are
  // persisted, so the channel reconnects from what it already holds; a channel
  // without a resume path, or a deployment with nothing stored, is unaffected.
  try {
    await channel.resume?.()
  } catch (error) {
    log.warn('channel resume failed', error)
  }

  /**
   * Effective user-tunable configuration. The composition entry is the base
   * layer; a mounted settings provider lets the Settings card override it at
   * runtime, and losing that provider restores exactly what the deployment
   * composed. The card polls its own state route, so no change push is needed.
   */
  const entry = Object.freeze({
    delaySeconds: config.delaySeconds,
    maxDetailChars: config.maxDetailChars,
    titlePrefix: config.titlePrefix,
    resultNotify: config.resultNotify,
    resultNotifyCooldownSeconds: config.resultNotifyCooldownSeconds,
    mirrorTtlSeconds: config.mirrorTtlSeconds,
  })
  let settings = entry
  // The provider owns the section, so none can be installed before one exists.
  // `inject` waits for the service instead of reading it once, which takes the
  // card off the load order; a deployment composing no provider keeps resolving
  // the composition entry alone. The owner stays this plugin's context: the
  // provider asks it whether the consumer is unloading before it restores that
  // entry as the source.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NAME, SectionSchema, entry, {
      setSource: (source) => { settings = source() },
      onChange: () => {},
    })
  })

  /** Live escalations keyed by the opaque id embedded in their action payloads. */
  const open = new Map()
  let closed = false

  /**
   * The last decision the phone took, for the browser half to mirror onto the
   * desktop's own composer. A forwarded request can only be finished by a
   * browser answering it, so a request the phone answered leaves that composer
   * waiting; the browser half replays this value through the same client call a
   * click makes, which clears it.
   */
  let desktopSync = null
  /**
   * What the browser half has done with the phone's decisions. Only the browser
   * can see whether a composer closed, so it reports each attempt here; the last
   * few also ride the state route, which is how a deployment diagnoses a mirror
   * that is not landing.
   */
  const mirrorReports = []

  /**
   * Describe one phone decision for the browser half.
   * @param record - the escalation the phone answered.
   * @param answer - the value the request settled with.
   * @returns the mirror record the state route serves.
   */
  const mirrorOf = (record, answer) => ({
    id: record.id,
    kind: record.kind,
    sessionId: record.request.agent?.id,
    questions: (record.request.questions ?? []).map(item => item.id),
    answer,
    at: Date.now(),
  })

  // Result notices ride the session firehose rather than a live request, so a
  // turn that ends while nobody is watching still reaches the phone.
  const results = createResultNotifier({ ctx, log, channel, settings: () => settings })

  /**
   * Bound rendered text; a plan review or a long reason otherwise overflows a
   * channel's message limit.
   * @param value - untrusted text from the request.
   * @returns the text, truncated with a marker when it exceeded the bound.
   */
  const clip = (value) => {
    const flat = String(value ?? '')
    return flat.length <= settings.maxDetailChars
      ? flat
      : `${flat.slice(0, settings.maxDetailChars)}\n…（内容过长已截断）`
  }

  /** Whether this request can be fully answered from a channel message. */
  const escalatable = (kind, request) => {
    if (kind === 'approval') return true
    if (channel.supportsForms === true) return true
    // Without form support only single-select option questions are answerable,
    // and a partially answerable request would strand its remaining questions.
    return request.questions.every(question =>
      (question.options ?? []).length > 0 && question.multiSelect !== true)
  }

  /**
   * Render one request as a channel-neutral message.
   * @param record - the live escalation.
   * @returns the view handed to the channel.
   */
  const buildView = (record) => {
    if (record.kind === 'approval') {
      const { toolName, callId, reason } = record.request
      const body = [`**工具**：\`${toolName}\``]
      if (callId !== undefined) body.push(`**调用 ID**：\`${callId}\``)
      if (reason !== undefined && reason !== '') body.push(`**原因**：${clip(reason)}`)
      body.push(settings.delaySeconds === 0
        ? '桌面与手机同时可答，先到者生效。批准仅对本次调用生效。'
        : `桌面 ${settings.delaySeconds} 秒内未应答，已升级到手机。批准仅对本次调用生效。`)
      return {
        title: `${settings.titlePrefix} 工具审批`,
        tone: 'warning',
        body,
        buttons: [
          { payload: { rid: record.id, v: ALLOW }, label: '批准一次', tone: 'primary' },
          { payload: { rid: record.id, v: REJECT }, label: '拒绝', tone: 'danger' },
        ],
        forms: [],
      }
    }

    const questions = record.request.questions
    const recorded = record.answers
    const body = []
    const buttons = []
    const forms = []
    // More than one question is the only case where progress is not obvious.
    if (questions.length > 1) {
      body.push(`**进度**：已答 ${recorded.size}/${questions.length}`)
    }
    for (const question of questions) {
      const heading = question.header === undefined ? '' : `**${question.header}**`
      const answer = recorded.get(question.id)
      if (answer !== undefined) {
        // A recorded answer keeps its place and loses its controls, so the user
        // sees what they already chose instead of a card that never changes.
        body.push([
          heading,
          question.question,
          `✅ ${answer.custom ?? answer.selected.join('、')}`,
        ].filter(Boolean).join('\n\n'))
        continue
      }
      body.push([
        heading,
        question.question,
        question.detail === undefined ? '' : clip(question.detail),
      ].filter(Boolean).join('\n\n'))

      const options = question.options ?? []
      // A button label carries no room for an option's description, so the
      // body holds the legend and the buttons stay the answer controls.
      if (options.some(option => option.description !== undefined && option.description !== '')) {
        body.push(['**选项**', ...options.map((option, index) => {
          const description = option.description === undefined || option.description === ''
            ? ''
            : ` — ${clip(option.description)}`
          return `${index + 1}. **${option.label}**${description}`
        })].join('\n'))
      }
      if (options.length === 0 || question.multiSelect === true) {
        forms.push({
          payload: { rid: record.id, q: question.id, submit: true },
          fieldId: FORM_VALUE_FIELD,
          ...(options.length === 0
            ? {}
            : {
                options: options.map(option => ({ label: option.label, value: option.label })),
                // A multi-select answer may carry text beside its choices, so
                // the form offers the second control the desktop card shows.
                customFieldId: FORM_CUSTOM_FIELD,
              }),
          multiSelect: question.multiSelect === true,
          submitLabel: '提交本题',
        })
        continue
      }
      for (const option of options) {
        buttons.push({
          payload: { rid: record.id, q: question.id, v: option.label },
          label: option.label,
          tone: 'default',
        })
      }
      // The desktop card always accepts a typed answer beside its options, so
      // the phone needs the same door; a single-select typed answer carries the
      // text alone, with no option selected.
      forms.push({
        payload: { rid: record.id, q: question.id, submit: true },
        fieldId: FORM_VALUE_FIELD,
        submitLabel: '提交其他回答',
      })
    }
    return {
      title: `${settings.titlePrefix} 提问`,
      tone: 'info',
      body,
      buttons,
      forms,
    }
  }

  /** The terminal view shown once a request has been decided. */
  const settledView = (record, headline, tone) => ({
    title: `${settings.titlePrefix} ${record.kind === 'approval' ? '工具审批' : '提问'}`,
    tone,
    body: [headline],
    buttons: [],
    forms: [],
  })

  /**
   * Register one escalation: arm the timer, keep the desktop chain running, and
   * settle with whichever side answers first.
   * @param request - the pending approval or question request.
   * @param next - delegate to the answerers behind this listener.
   * @param kind - which seam is being escalated.
   */
  function escalate(request, next, kind) {
    const desktop = next()
    // A channel that cannot deliver right now must not arm a timer: the desktop
    // chain stays authoritative and no request is left waiting on a message
    // that will never arrive.
    if (closed || channel.available?.() === false || !escalatable(kind, request)) return desktop

    const record = {
      id: randomUUID().replaceAll('-', '').slice(0, 20),
      kind,
      request,
      handle: undefined,
      delivered: false,
      timer: undefined,
      finished: false,
      answers: new Map(),
      settle: Promise.withResolvers(),
      onAbort: undefined,
    }
    record.view = buildView(record)
    open.set(record.id, record)

    /** Release the timer and the registry slot without settling the race. */
    const release = () => {
      if (record.timer !== undefined) {
        clearTimeout(record.timer)
        record.timer = undefined
      }
      open.delete(record.id)
      request.signal?.removeEventListener('abort', record.onAbort)
    }

    /**
     * Close the escalation and, when a message went out, show its outcome.
     * @returns true only for the first caller.
     */
    record.complete = (outcome, headline, tone) => {
      if (record.finished) return false
      record.finished = true
      release()
      if (record.delivered && headline !== undefined && typeof channel.update === 'function') {
        void Promise.resolve(channel.update(record.handle, settledView(record, headline, tone)))
          .catch(error => { log.warn('message rewrite failed', error) })
      }
      if (outcome !== undefined) record.settle.resolve(outcome)
      return true
    }

    record.onAbort = () => { record.complete(undefined, '该请求已取消', 'muted') }
    if (request.signal?.aborted === true) {
      record.complete(undefined, undefined, 'muted')
      return desktop
    }
    request.signal?.addEventListener('abort', record.onAbort, { once: true })

    record.timer = setTimeout(() => {
      record.timer = undefined
      void Promise.resolve(channel.deliver(record.view)).then((handle) => {
        record.handle = handle
        record.delivered = true
      }).catch((error) => {
        // A failed delivery must not strand the request: fall through to the
        // desktop branch, which is still pending.
        log.warn('message delivery failed', error)
        record.complete(undefined, undefined, 'muted')
      })
    }, settings.delaySeconds * 1000)
    record.timer.unref?.()

    return Promise.race([
      Promise.resolve(desktop).then((outcome) => {
        record.complete(undefined, '已在桌面端处理', 'success')
        return outcome
      }),
      record.settle.promise,
    ])
  }

  /** Answer one approval from an action payload. */
  const decodeApproval = (record, payload) => {
    if (payload?.v !== ALLOW && payload?.v !== REJECT) return undefined
    const label = payload.v === ALLOW ? '已批准（仅本次）' : '已拒绝'
    // Only the answer that actually settles the request is mirrored: a click
    // arriving after the desktop already decided changes nothing.
    if (record.complete(payload.v, label, payload.v === ALLOW ? 'success' : 'danger')) {
      desktopSync = mirrorOf(record, payload.v)
    }
    return { toast: label }
  }

  /** Answer one question, resolving once every question has an answer. */
  const decodeQuestion = (record, payload, values) => {
    const question = record.request.questions.find(item => item.id === payload?.q)
    if (question === undefined) return undefined

    let answer
    if (payload.submit === true) {
      const submitted = values?.[FORM_VALUE_FIELD]
      const typed = values?.[FORM_CUSTOM_FIELD]
      const selected = Array.isArray(submitted) ? submitted.map(String) : []
      // A form with no options carries its typed answer in the value field; a
      // multi-select form carries choices there and the typed answer beside
      // them, which is the pair the desktop card submits.
      const custom = typeof submitted === 'string' && submitted !== ''
        ? submitted
        : typeof typed === 'string' && typed.trim() !== '' ? typed.trim() : undefined
      if (selected.length === 0 && custom === undefined) return undefined
      answer = { id: question.id, selected, ...(custom === undefined ? {} : { custom }) }
    } else {
      const label = payload?.v
      if (typeof label !== 'string'
        || !(question.options ?? []).some(option => option.label === label)) {
        return undefined
      }
      answer = { id: question.id, selected: [label] }
    }

    record.answers.set(question.id, answer)
    const answered = record.answers.size
    const total = record.request.questions.length
    if (answered < total) {
      // Rewrite the message so the user sees what is already recorded; a toast
      // alone would leave a card that looks untouched.
      if (record.delivered && typeof channel.update === 'function') {
        void Promise.resolve(channel.update(record.handle, buildView(record)))
          .catch(error => { log.warn('message rewrite failed', error) })
      }
      return { toast: `已记录 ${answered}/${total} 题` }
    }

    const answers = record.request.questions
      .map(item => record.answers.get(item.id))
      .filter(Boolean)
    const accepted = record.complete(
      { answers },
      `已回答：${clip(answers.map(item => `${item.id}=${item.custom ?? item.selected.join('/')}`).join('；'))}`,
      'success',
    )
    if (accepted) desktopSync = mirrorOf(record, { answers })
    return { toast: '已提交全部回答' }
  }

  /** The card's status snapshot: what the section serves and what is open. */
  const snapshot = async () => ({
    namespace: NAME,
    settings: { ...settings },
    /** Open escalations, each with what it is waiting on. */
    pending: [...open.values()].map((record) => {
      const question = record.request.questions?.[0]
      return {
        kind: record.kind,
        summary: clip(record.kind === 'approval'
          ? record.request.toolName
          : question?.header ?? question?.question ?? ''),
        delivered: record.delivered,
      }
    }),
    enrollment: await channel.enrollmentState?.() ?? { state: 'unsupported' },
    /**
     * The decision the browser half should mirror onto the desktop composer,
     * while it is still recent enough to belong to the request on screen.
     */
    sync: desktopSync !== null && Date.now() - desktopSync.at <= settings.mirrorTtlSeconds * 1000
      ? desktopSync
      : null,
    /** What the browser half last did with a decision, newest last. */
    mirror: [...mirrorReports],
  })

  /** The two mutations the card asks for. */
  const actions = {
    begin: async () => await channel.beginEnrollment?.() ?? { state: 'unsupported' },
    clear: async () => await channel.clearEnrollment?.() ?? { state: 'unsupported' },
    /**
     * Record one browser-half mirror attempt.
     * @param body - what the browser half did: status, and why when it could not.
     * @returns the accepted report.
     */
    mirror: async (body) => {
      const report = {
        at: Date.now(),
        status: typeof body?.status === 'string' ? body.status : 'unknown',
        ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body?.syncId === 'string' ? { syncId: body.syncId } : {}),
      }
      mirrorReports.push(report)
      if (mirrorReports.length > 20) mirrorReports.shift()
      // The state route carries these; the deployment log only needs them when
      // someone asks, since a page load alone produces several.
      log.debug(`桌面镜像：${report.status}${report.reason === undefined ? '' : `（${report.reason}）`}`)
      return report
    },
  }

  // The routes live on the web app's server, which a headless deployment never
  // composes. Registering them through `inject` follows the service instead of
  // the load order, and they leave with it.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerRoutes(webCtx.webServer, snapshot, actions), 'pocket-console: routes')
  })

  ctx.effect(() => {
    const offApproval = ctx.on(
      'approval/request',
      (request, next) => escalate(request, next, 'approval'),
      { prepend: true },
    )
    const offQuestion = ctx.on(
      'user-questions/request',
      (request, next) => escalate(request, next, 'question'),
      { prepend: true },
    )
    const offResults = results.install()
    const offAction = channel.subscribe(({ payload, values }) => {
      const notice = results.handleAction(payload, values)
      if (notice !== undefined) return notice
      const id = typeof payload?.rid === 'string' ? payload.rid : undefined
      const record = id === undefined ? undefined : open.get(id)
      if (record === undefined) return { toast: '该请求已处理或已过期', accepted: false }
      const outcome = record.kind === 'approval'
        ? decodeApproval(record, payload)
        : decodeQuestion(record, payload, values)
      if (outcome === undefined) return { toast: '无法识别该操作', accepted: false }
      return { toast: outcome.toast, accepted: true }
    })

    // Without a server there is no card to ask for a binding, so the
    // deployment's only surface is the log: start onboarding immediately.
    if (ctx.get('webServer') === undefined) {
      log.info('webServer is absent; starting enrollment and printing the link instead.')
      channel.beginEnrollment?.()
    }

    return () => {
      offApproval()
      offQuestion()
      offResults()
      offAction()
      closed = true
      // Abandon rather than settle: the desktop branch of each in-flight race
      // stays authoritative, so a still-open GUI can answer normally.
      for (const record of [...open.values()]) {
        if (record.timer !== undefined) clearTimeout(record.timer)
        record.finished = true
        open.delete(record.id)
      }
      try {
        channel.close?.()
      } catch (error) {
        log.warn('channel close failed', error)
      }
    }
  }, 'pocket-console: answerers and channel')
}
