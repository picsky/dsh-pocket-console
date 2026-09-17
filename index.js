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

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { createResultNotifier } from './results.js'
import { createEscalation } from './escalation.js'
import { LOCALES, messagesFor } from './messages.js'
import { createMirror } from './mirror.js'
import { registerRoutes } from './routes.js'

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
   * Language of the cards sent to the phone. The GUI card is bilingual on its
   * own; this is the copy a person reads in the chat app.
   * @default 'zh'
   */
  locale: z.union(LOCALES).default('zh'),
  /**
   * Seconds a phone decision stays on offer for the browser half to mirror onto
   * the desktop composer. Long enough to cover a page that is already open,
   * short enough that a reloaded page never replays an old answer.
   * @default 60
   */
  mirrorTtlSeconds: z.natural().default(60),
  /**
   * Seconds a result notice keeps accepting a reply. Past it the card still
   * shows the result, but the instruction it would inject is refused.
   * @default 1800
   */
  resultNoticeTtlSeconds: z.natural().default(1800),
})

/** Settings namespace and browser-card slot key; lowercase-hyphenated per the settings grammar. */
const NAME = 'pocket-console'

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
  /** Language of the cards sent to the phone. */
  locale: z.union(LOCALES).default('zh'),
  /** Seconds a phone decision stays on offer for the desktop mirror. */
  mirrorTtlSeconds: z.natural().default(60),
  /** Seconds a result notice keeps accepting a reply. */
  resultNoticeTtlSeconds: z.natural().default(1800),
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
  // The channel renders its own chrome, so it reads the same copy the core does.
  const channel = await module.create({
    ctx,
    config: config.channelConfig ?? {},
    binding: createBinding(ctx),
    log,
    messages: () => messagesFor(config.locale),
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
    resultNoticeTtlSeconds: config.resultNoticeTtlSeconds,
    locale: config.locale,
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

  // The decision the phone took, and what the browser half did with it.
  const mirror = createMirror({ log, settings: () => settings })
  /** The card copy in the deployment's language, read per render. */
  const messages = () => messagesFor(settings.locale)

  // The escalation machine owns the timer, the race, and the pending registry;
  // this file only wires it to the two seams and the channel's actions.
  const escalation = createEscalation({ log, channel, settings: () => settings, mirror, messages })

  // Result notices ride the session firehose rather than a live request, so a
  // turn that ends while nobody is watching still reaches the phone.
  const results = createResultNotifier({ ctx, log, channel, settings: () => settings, messages })

  /** The card's status snapshot: what the section serves and what is open. */
  const snapshot = async () => ({
    namespace: NAME,
    settings: { ...settings },
    /** Open escalations, each with what it is waiting on. */
    pending: escalation.pending(),
    enrollment: await channel.enrollmentState?.() ?? { state: 'unsupported' },
    ...mirror.state(),
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
    mirror: async (body) => mirror.report(body),
  }

  // The routes live on the web app's server, which a headless deployment never
  // composes. Registering them through `inject` follows the service instead of
  // the load order, and they leave with it. `connection` is read through `get`
  // because it is the browser surface's service: a deployment without one keeps
  // the same-origin check alone.
  ctx.inject(['webServer'], (webCtx) => {
    const trust = (req) => ctx.get?.('connection')?.requestRejection?.(req)
    webCtx.effect(
      () => registerRoutes(webCtx.webServer, snapshot, actions, trust),
      'pocket-console: routes',
    )
  })

  ctx.effect(() => {
    const offApproval = ctx.on(
      'approval/request',
      (request, next) => escalation.escalate(request, next, 'approval'),
      { prepend: true },
    )
    const offQuestion = ctx.on(
      'user-questions/request',
      (request, next) => escalation.escalate(request, next, 'question'),
      { prepend: true },
    )
    const offResults = results.install()
    const offAction = channel.subscribe(({ payload, values }) => {
      const notice = results.handleAction(payload, values)
      if (notice !== undefined) return notice
      return escalation.handleAction(payload, values)
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
      // Abandon rather than settle: the desktop branch of each in-flight race
      // stays authoritative, so a still-open GUI can answer normally.
      escalation.close()
      try {
        channel.close?.()
      } catch (error) {
        log.warn('channel close failed', error)
      }
    }
  }, 'pocket-console: answerers and channel')
}
