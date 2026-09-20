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
import { createActivity } from './activity.js'
import { createRunRecord } from './run-record.js'
import { createWork } from './work.js'
import { LOCALES, messagesFor } from './messages.js'
import { createMirror } from './mirror.js'
import { createPriority, DESK } from './priority.js'
import { createWorkspaces } from './workspaces.js'
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
  /** Title prefix identifying the deployment. @default 'DSH' */
  titlePrefix: z.string().default('DSH'),
  /**
   * Whether a stopped session's answer is offered to the channel with a box for
   * the next instruction. `'idle'` enables it; `'off'` leaves the channel to
   * live requests only. A fresh install notifies, because a result nobody
   * hears about is the state this plugin exists to fix.
   * @default 'idle'
   */
  resultNotify: z.union(['off', 'idle']).default('idle'),
  /**
   * Seconds before the same session may notify again, so a session running many
   * short turns does not flood the channel. The quiet window already collapses a
   * run of turns; this is the brake for a deployment that sets `delaySeconds` to
   * zero and watches a session churn.
   * @default 0
   */
  resultNotifyCooldownSeconds: z.natural().default(0),
  /**
   * Language of the cards sent to the phone, used until a browser tells the Host
   * which language the interface is in. A deployment that never opens the Web UI
   * keeps this copy.
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
})

/** Settings namespace and browser-card slot key; lowercase-hyphenated per the settings grammar. */
const NAME = 'pocket-console'

/**
 * The user-tunable slice of this plugin, surfaced as a Settings card.
 *
 * A setting earns a place here when a person could want a different answer and
 * can reason about the consequence. Timers that only exist to keep the transport
 * well-behaved — the notice cooldown and the mirror window — stay in `Config`,
 * where a deployment can still set them and nobody has to read about them.
 */
const SectionSchema = z.object({
  /** Seconds the desktop GUI may answer before the channel is used. */
  delaySeconds: z.natural().default(120),
  /** Title prefix identifying the deployment. */
  titlePrefix: z.string().default('DSH'),
  /** Whether a stopped session's answer is offered to the channel. */
  resultNotify: z.union(['off', 'idle']).default('idle'),
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
  /**
   * Effective user-tunable configuration. The composition entry is the base
   * layer; a mounted settings provider lets the Settings card override it at
   * runtime, and losing that provider restores exactly what the deployment
   * composed. The card polls its own state route, so no change push is needed.
   *
   * It is resolved before the channel because the copy thunk below reads it: a
   * channel resolves its own defaults at creation, and one of them is copy.
   */
  const entry = Object.freeze({
    delaySeconds: config.delaySeconds,
    titlePrefix: config.titlePrefix,
    resultNotify: config.resultNotify,
    resultNotifyCooldownSeconds: config.resultNotifyCooldownSeconds,
    mirrorTtlSeconds: config.mirrorTtlSeconds,
    locale: config.locale,
  })
  let settings = entry

  /**
   * Read the effective settings back from the provider.
   *
   * The provider hands over a source once and then only reports that something
   * changed, so the current value has to be read through that source on every
   * change. Keeping whatever the source returned at install time meant a card edit
   * reached the plugin only after a restart — the one thing a settings card must
   * never require.
   */
  let readSettings = () => entry

  /**
   * The two machines that count a wait down, declared before anything can re-time
   * them: the settings provider hands its source over synchronously, so
   * `reloadSettings` runs before either exists.
   */
  let escalation
  let results

  /**
   * Read the new values, then re-time everything already counting them down.
   *
   * An escalation's timer and a notice's calm window are armed from the value in
   * force when they started, so an edit that only reached the next request would
   * read as a setting that did not save — and the reader's next move would be to
   * restart `dsh`, which withdraws every outstanding notice for nothing.
   */
  const reloadSettings = () => {
    settings = readSettings()
    escalation?.rearm()
    results?.rearm()
  }

  /**
   * The interface language a browser reported, until it reports another. The Host
   * cannot see a browser's language any other way, and a deployment whose page
   * never opens leaves its own `locale` in charge.
   */
  let uiLocale
  /** The card copy in the language the reader is actually reading. */
  const messages = () => messagesFor(uiLocale ?? settings.locale)

  // The channel renders its own chrome, so it reads the same copy the core does.
  const channel = await module.create({
    ctx,
    config: config.channelConfig ?? {},
    binding: createBinding(ctx),
    log,
    messages,
  })

  // A restart must not need the Settings card. Credentials and recipient are
  // persisted, so the channel reconnects from what it already holds; a channel
  // without a resume path, or a deployment with nothing stored, is unaffected.
  try {
    await channel.resume?.()
  } catch (error) {
    log.warn('channel resume failed', error)
  }

  // The provider owns the section, so none can be installed before one exists.
  // `inject` waits for the service instead of reading it once, which takes the
  // card off the load order; a deployment composing no provider keeps resolving
  // the composition entry alone. The owner stays this plugin's context: the
  // provider asks it whether the consumer is unloading before it restores that
  // entry as the source.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NAME, SectionSchema, entry, {
      setSource: (source) => { readSettings = source; reloadSettings() },
      onChange: reloadSettings,
    })
  })

  // The decision the phone took, and what the browser half did with it.
  const mirror = createMirror({ log, settings: () => settings, messages })

  // What each card on the phone calls its session's workspace, kept beside the message
  // rather than only on the record: a card rewritten after a restart has no record left.
  const workspaces = createWorkspaces()

  /**
   * Which side the person is on, which is what decides the wait both timers count down.
   *
   * Durable, because a restart that put a person who is away back behind a desk head start
   * would make the phone go quiet exactly when it is the only surface there is.
   */
  const priority = createPriority({
    ctx,
    log,
    settings: () => settings,
    messages,
    // What a return to the desk is *for*: a request that arrived while the phone held the person
    // skipped the head start rather than shortening it, and without this it would stay on the
    // phone even once somebody is sitting at the desk again. Wired here rather than at each
    // caller, because more than one path puts the person back and none of them should have to
    // know about this.
    returnedToDesk: () => escalation?.deskReturn(),
  })
  try {
    await priority.restore()
  } catch (error) {
    log.warn('priority restore failed', error)
  }

  // The escalation machine owns the timer, the race, and the pending registry;
  // this file only wires it to the two seams and the channel's actions.
  escalation = createEscalation({
    log, channel, settings: () => settings, mirror, messages, workspaces, priority,
  })

  // The activity card follows a run while it runs, but only once the phone holds the person:
  // while the desk has them, the run is visible where they already are.
  const activity = createActivity({
    ctx, log, channel, settings: () => settings, messages, priority, workspaces,
  })

  // What each run did, kept on its own account rather than on a card: the result card shows it, so
  // it has to exist for runs that never had a card at all.
  const runRecord = createRunRecord({ messages })

  // Starting the next shard is the one thing a finished result cannot do, and the moment a result
  // lands is when the phone has the person's attention — so the offer follows the notice.
  const work = createWork({
    ctx, log, channel, settings: () => settings, messages, workspaces, priority,
  })
  // Result notices ride the session firehose rather than a live request, so a
  // turn that ends while nobody is watching still reaches the phone.
  results = createResultNotifier({
    ctx,
    log,
    channel,
    settings: () => settings,
    messages,
    workspaces,
    priority,
    onSent: async (session) => { await work.offer(session) },
  })

  /** The card's status snapshot: what the section serves and what is open. */
  const snapshot = async () => ({
    namespace: NAME,
    settings: { ...settings },
    /** Which side is in force, which is what the effective wait follows. */
    priority: priority.get(),
    /** Open escalations, each with what it is waiting on. */
    pending: escalation.pending(),
    /** How many runs the activity card follows, and which one it would forget next. */
    activity: { tracked: activity.tracked(), order: activity.order() },
    enrollment: await channel.enrollmentState?.() ?? { state: 'unsupported' },
    ...mirror.state(),
  })

  /** The two mutations the card asks for. */
  const actions = {
    begin: async () => await channel.beginEnrollment?.() ?? { state: 'unsupported' },
    /**
     * Adopt an app the user already has, by the credentials they pasted.
     * @param body - the app id and secret from the developer console.
     * @returns the enrollment state after connecting.
     */
    adopt: async (body) => await channel.adoptCredentials?.({
      appId: body?.appId,
      appSecret: body?.appSecret,
    }) ?? { state: 'unsupported' },
    clear: async () => await channel.clearEnrollment?.() ?? { state: 'unsupported' },
    /**
     * Record one browser-half mirror attempt.
     * @param body - what the browser half did: status, and why when it could not.
     * @returns the accepted report.
     */
    mirror: async (body) => {
      // The page is the only source for which language its reader is reading.
      if (body?.lang === 'zh' || body?.lang === 'en') uiLocale = body.lang
      return mirror.report(body)
    },
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

  // The notices from the previous run come back when the durable storage that holds them
  // is up. Waiting for the service is the point: a restore that ran before it existed
  // would find nothing and leave the card blaming an expiry that never happened.
  ctx.inject(['storageDomain'], () => {
    void results.restore().catch(error => { log.warn(messages().logNoticeRestoreFailed, error) })
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
    const offActivity = activity.install()
    // What one run did, recorded per session and independently of any card. It is a third reader of
    // the same firehose rather than part of the activity card, because the card only exists while
    // the phone holds the person — and the run somebody asks about afterwards may well have happened
    // at the desk, or be the first one after the phone took over.
    const offRunRecord = ctx.on('session/event', (session, event) => { runRecord.observe(session, event) })
    const offRunStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      runRecord.observeStream(agent?.id, frame)
    })
    // A card is minted when the phone takes the person, so the activity card has to hear
    // about the move rather than wait for the session's next event to notice. The same
    // move in the other direction is what gives a head start back to a request that
    // arrived while the phone held the person — its card skipped the wait entirely, and
    // without this it would sit on the phone even once somebody is back at the desk.
    const offPriority = priority.subscribe((side) => {
      activity.onPriority()
      if (side === DESK) escalation.deskReturn()
    })
    const offAction = channel.subscribe(async (action) => {
      // The action carries the message the press came from, which is how a card whose
      // request is gone — after a restart, or once settled — is rewritten to stop
      // looking answerable. It reaches every decoder for that reason.
      //
      // The new-task handler goes first because it is the only one that *starts* something: a
      // payload that names it must never fall through to a decoder that would treat the same
      // press as an answer to a request. Each handler returns undefined for what is not its own.
      const started = await work.handleAction(action)
      if (started !== undefined) return started
      const notice = await results.handleAction(action)
      if (notice !== undefined) return notice
      return escalation.handleAction(action)
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
      offActivity()
      offRunRecord()
      offRunStream()
      offPriority()
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
