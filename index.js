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
import { createDiagnostics } from './diagnostics.js'
import { isDelegated } from './delegated.js'
import { createRunRecord } from './run-record.js'
import { createSessionNames } from './session-names.js'
import { createWork } from './work.js'
import { LOCALES, messagesFor } from './messages.js'
import { createMirror } from './mirror.js'
import { createPriority, DESK } from './priority.js'
import { createWorkspaces } from './workspaces.js'
import { createInbound } from './inbound.js'
import { registerRoutes } from './routes.js'

/** Plugin name used by the Loader and every diagnostic. */
export const name = 'pocket-console'

/** Required service: the credential store holds channel secrets and the binding. */
export const inject = ['credentials']

/**
 * Mark one `Config` field as editable through the running Host's settings form.
 *
 * Up to 0.1.6 the user-tunable slice of this plugin is installed as a settings
 * section of its own and `Config` stays plain. From 0.1.7 the settings service
 * projects each entry's own `Config` instead — but exposes only the fields
 * declared volatile, whose value then arrives as a reference read with `get()`
 * rather than as the value itself.
 *
 * The marker is what the Host reads, and `volatile()` is only the helper that
 * writes it: `volatile()` is `extra('volatile', true)` in the library that has
 * both, and `extra` is the older of the two. Asking for the helper instead of
 * writing the marker costs the whole form on a Host whose resolved library lacks
 * it — which is any profile that hoists a schemastery older than the one the Host
 * carries, because this plugin's peer range is `*` and the Host's own
 * compatibility gate never evaluates a peer that is not `@deepseek-ai/dsh-*`. That
 * is how 3.18.1 beside a 0.1.7 Host left every field unmarked: no form was built
 * for the entry, and the card could report only that the Host serves none.
 *
 * So `extra` is the floor, and the helper is used when it is there. A library with
 * neither leaves the field unmarked — the shape this was before the fix — and
 * `tests/host-contract.test.mjs` fails on that shape instead of reporting it.
 * @param schema - the field's schema.
 * @returns the schema, marked volatile.
 */
const liveField = (schema) => {
  if (typeof schema.volatile === 'function') return schema.volatile()
  if (typeof schema.extra === 'function') return schema.extra('volatile', true)
  return schema
}

/**
 * Read one `Config` field, whichever shape the running Host handed over.
 *
 * A volatile field is a stable reference the Loader updates in place when the
 * settings form writes, so it has to be read at use rather than captured at load;
 * every other field is the value itself.
 * @param value - the resolved `Config` field.
 * @returns the value in force right now.
 */
const readField = (value) => (
  value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
)

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
  delaySeconds: liveField(z.natural().default(120)),
  /** Title prefix identifying the deployment. @default 'DSH' */
  titlePrefix: liveField(z.string().default('DSH')),
  /**
   * Whether a stopped session's answer is offered to the channel with a box for
   * the next instruction. `'idle'` enables it; `'off'` leaves the channel to
   * live requests only. A fresh install notifies, because a result nobody
   * hears about is the state this plugin exists to fix.
   * @default 'idle'
   */
  resultNotify: liveField(z.union(['off', 'idle']).default('idle')),
  /**
   * Seconds before the same session may notify again, so a session running many
   * short turns does not flood the channel. The quiet window already collapses a
   * run of turns; this is the brake for a deployment that sets `delaySeconds` to
   * zero and watches a session churn.
   * @default 0
   */
  resultNotifyCooldownSeconds: z.natural().default(0),
  /**
   * Whether the plugin narrates what it decides about every card.
   *
   * Off by default, and that default is the point: this is the switch a deployment turns on to find
   * out *why* a card did or did not change, and a plugin that narrated everything all the time would
   * bury its own warnings in its own noise. What it gates is a class of line this repository learned
   * it needed the hard way — a card that is **not** rewritten is otherwise indistinguishable from one
   * whose rewrite was attempted and failed, because the branch that skips it says nothing at all.
   *
   * It gates the plugin's own diagnostics, not the deployment's log level: Cordis exporters decide
   * which levels reach a terminal, so a deployment that wants these lines must also run its logger at
   * `debug`. Both are deliberate — the plugin should not be able to make a deployment's log louder
   * than the deployment asked for.
   *
   * Spelled `'off' | 'on'` rather than as a boolean because the settings card is built from one
   * control per field and its two kinds are a text box and a dropdown: a boolean field the card
   * cannot render would be a setting reachable only by editing YAML, which is the opposite of what it
   * is for.
   * @default 'off'
   */
  debug: liveField(z.union(['off', 'on']).default('off')),
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
  /** Whether the plugin narrates what it decides about each card. */
  debug: z.union(['off', 'on']).default('off'),
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
   * Effective user-tunable configuration, read now.
   *
   * Two live-ness models meet here, and neither may be cached. Up to 0.1.6 a
   * mounted settings provider installs a section of its own over {@link entry}
   * and hands over a source that re-reads the document; from 0.1.7 there is no
   * such section — the settings service projects the plugin's own `Config`
   * instead, and the fields declared volatile are references the Loader updates in
   * place when the form writes, so the value has to be taken from the reference at
   * use. `liveEntry` covers the second and the provider's source overrides it for
   * the first, which is also what restores exactly what the deployment composed
   * when no provider is mounted. The card polls its own state route, so no change
   * push is needed either way.
   *
   * It is resolved before the channel because the copy thunk below reads it: a
   * channel resolves its own defaults at creation, and one of them is copy.
   */
  const liveEntry = () => Object.freeze({
    delaySeconds: readField(config.delaySeconds),
    titlePrefix: readField(config.titlePrefix),
    resultNotify: readField(config.resultNotify),
    resultNotifyCooldownSeconds: readField(config.resultNotifyCooldownSeconds),
    mirrorTtlSeconds: readField(config.mirrorTtlSeconds),
    locale: readField(config.locale),
  })
  /** The composition layer: what the deployment composed, before any user edit. */
  const entry = liveEntry()

  /**
   * The source of the effective values. Replaced by the settings provider when one
   * is mounted; volatile `Config` fields need no replacement, because reading them
   * is already reading the document the form writes into.
   */
  let readSettings = liveEntry

  /**
   * The two machines that count a wait down, declared before anything can re-time
   * them: the settings provider hands its source over synchronously, so
   * `reloadSettings` runs before either exists.
   */
  let escalation
  let results

  /**
   * The values a countdown was last timed from.
   *
   * 0.1.7 has no change event for a volatile field — the form writes the document
   * and the reference simply reads differently — so re-timing cannot be driven by
   * a notification there. Comparing the timing values on every read re-arms on the
   * next read instead, and by then the card's own poll has already asked.
   */
  const timingOf = (values) => [values.delaySeconds, values.resultNotify, values.resultNotifyCooldownSeconds].join('|')
  let timing = timingOf(entry)

  /**
   * The effective settings, and the one place a change is noticed.
   * @returns the values in force right now.
   */
  const settingsNow = () => {
    const next = readSettings()
    const now = timingOf(next)
    if (now !== timing) {
      // Recorded before re-timing: re-arming reads the settings again, and a
      // detector that had not already moved on would recurse through it.
      timing = now
      escalation?.rearm()
      results?.rearm()
    }
    return next
  }

  /**
   * Read the new values, then re-time everything already counting them down.
   *
   * An escalation's timer and a notice's calm window are armed from the value in
   * force when they started, so an edit that only reached the next request would
   * read as a setting that did not save — and the reader's next move would be to
   * restart `dsh`, which withdraws every outstanding notice for nothing.
   */
  const reloadSettings = () => {
    settingsNow()
  }

  /**
   * The interface language a browser reported, until it reports another. The Host
   * cannot see a browser's language any other way, and a deployment whose page
   * never opens leaves its own `locale` in charge.
   */
  let uiLocale
  /** The card copy in the language the reader is actually reading. */
  const messages = () => messagesFor(uiLocale ?? settingsNow().locale)

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
  //
  // `installSection` is the ≤0.1.6 contract. 0.1.7 projects the entry's own
  // `Config` into a form instead of accepting a section, so there is nothing to
  // install there — the volatile fields above are already what the card edits —
  // and the generated page for them is turned off because this plugin ships its
  // own. Both are asked for by capability rather than by version, so either
  // service shape loads.
  ctx.inject(['settings'], (settingsCtx) => {
    const settingsService = settingsCtx.settings
    const installs = typeof settingsService.installSection === 'function'
    const projects = typeof settingsService.configure === 'function'
    if (installs) {
      settingsService.installSection(ctx, NAME, SectionSchema, entry, {
        setSource: (source) => { readSettings = source; reloadSettings() },
        onChange: reloadSettings,
      })
    }
    if (projects) {
      // The policy is registered against this plugin's own fiber, which is the
      // identity the form projection keys it by.
      settingsCtx.effect(() => settingsService.configure({ auto: false }, ctx.fiber))
    }
    // Neither shape is not a supported Host — it is a settings service this plugin
    // does not recognize, and the symptom is the worst kind: the card still draws and
    // still saves, while whatever the reader types goes nowhere the Host persists.
    // The deployment log is the only surface left, so it says which capabilities were
    // probed, by name, rather than the reader having to guess from a silent no-op.
    if (!installs && !projects) {
      log.info(messages().logSettingsTransportUnknown(
        `installSection=${typeof settingsService.installSection}, configure=${typeof settingsService.configure}`,
      ))
    }
  })

  // The decision the phone took, and what the browser half did with it.
  const mirror = createMirror({ log, settings: settingsNow, messages })

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
    settings: settingsNow,
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

  // Where the plugin says what it decided about a card, when the deployment asks to hear it. Built
  // once and handed to the modules that decide, so "why did that card not change" has one answer in
  // one place instead of three modules each inventing their own line.
  const diagnostics = createDiagnostics({ settings: settingsNow, log })

  // What each session is called, for the small line under a card's title. A project with two sessions
  // running in it makes two identical titles, and the name is the only thing that separates them —
  // the harness already gives every session one, so this only has to remember it. Built here rather
  // than beside the other registries because it reports through `diagnostics`, which is defined just
  // above; every card producer below takes it, so nothing can be built before it exists.
  const sessionNames = createSessionNames({ ctx, messages, log, diagnostics })

  // The escalation machine owns the timer, the race, and the pending registry;
  // this file only wires it to the two seams and the channel's actions.
  escalation = createEscalation({
    log, channel, settings: settingsNow, mirror, messages, workspaces, priority, sessionNames,
    diagnostics,
  })

  // The activity card follows a run while it runs, but only once the phone holds the person:
  // while the desk has them, the run is visible where they already are.
  const activity = createActivity({
    ctx, log, channel, settings: settingsNow, messages, priority, workspaces, sessionNames,
    diagnostics,
  })

  // What each run did, kept on its own account rather than on a card: the result card shows it, so
  // it has to exist for runs that never had a card at all.
  const runRecord = createRunRecord({ messages })

  // Starting the next shard is the one thing a finished result cannot do. It used to follow the
  // notice as a card of its own, which cost a second notification for one run; now it rides on the
  // result card, so the offer is handed *to* the notifier rather than called after it.
  const work = createWork({
    ctx, log, channel, settings: settingsNow, messages, workspaces, priority,
  })
  // Result notices ride the session firehose rather than a live request, so a
  // turn that ends while nobody is watching still reaches the phone.
  results = createResultNotifier({
    ctx,
    log,
    channel,
    settings: settingsNow,
    messages,
    workspaces,
    priority,
    diagnostics,
    // The run the person last started, so the card carries what happened rather than only the last
    // thing said.
    runRecord,
    // The next-task offer, appended to the card this notifier is about to send.
    nextTask: work,
    // The run's own card, so a reply can leave the run on the message it was typed on instead of
    // opening another one.
    activity,
    // Which session each card belongs to, for the small line under its title.
    sessionNames,
  })

  // The other input surface: a typed message in the chat. Built after the notifier because a quoted
  // instruction is delivered through it — the reply path is the same code a form reply takes — and the
  // escalation machine comes with it, because a message that quotes an open approval or question *is*
  // that answer, through the same decoder a button press goes through.
  const inbound = createInbound({ log, messages, diagnostics, workspaces, results, work, escalation })

  /** The card's status snapshot: what the section serves and what is open. */
  const snapshot = async () => ({
    namespace: NAME,
    settings: { ...settingsNow() },
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
    //
    // A delegated session is not recorded: no card of its own is ever built from this, and the map
    // is bounded at {@link module:pocket-console/run-record}'s capacity — so a fan-out of subagents
    // could otherwise push the real session's fold out of it.
    const offRunRecord = ctx.on('session/event', (session, event) => {
      if (!isDelegated(session)) runRecord.observe(session, event)
    })
    // Which session each card belongs to, read off the same firehose: the harness appends a
    // `session/title` event when a session gets its name, and this is the only place that hears it.
    const offSessionNames = ctx.on('session/event', (session, event) => { sessionNames.observe(session, event) })
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
      // What arrived and who took it, said before anything decides. This is the one line that makes
      // "the press did nothing" answerable: every decoder below is written to return `undefined` for
      // what is not its own — which is correct and, until this line existed, completely silent, so a
      // press that reached no handler at all and a press a handler rejected looked identical from
      // both ends. The payload is printed because the interesting case is always a payload that does
      // not carry what its decoder looks for.
      diagnostics(
        `收到动作：payload=${JSON.stringify(action?.payload ?? null)}，消息=${String(action?.messageId ?? '无')}。`,
      )
      // The action carries the message the press came from, which is how a card whose
      // request is gone — after a restart, or once settled — is rewritten to stop
      // looking answerable. It reaches every decoder for that reason.
      //
      // The new-task handler goes first because it is the only one that *starts* something: a
      // payload that names it must never fall through to a decoder that would treat the same
      // press as an answer to a request. Each handler returns undefined for what is not its own.
      //
      // The aftermath rewrite is the notifier's, and it is handed in rather than called by the work
      // module: the offer only knows what it added to a card, while the notifier is the side that
      // knows what the card already carried — the answer and the run fold, which a rewrite from the
      // wrong side would drop.
      const started = await work.handleAction(action, messageId => results.aftermath(messageId))
      if (started !== undefined) {
        diagnostics('动作由「开新任务」处理。')
        return started
      }
      const notice = await results.handleAction(action)
      if (notice !== undefined) {
        diagnostics('动作由「结果卡」处理。')
        return notice
      }
      const answered = escalation.handleAction(action)
      diagnostics(answered === undefined
        ? '动作没有任何处理器认领——它到此为止，什么也不会发生。'
        : '动作由「审批/提问」处理。')
      return answered
    })
    // The typed half of the same idea: a message in the chat, quoting one of our cards. The channel
    // has already checked that it came from the bound recipient in a direct chat and that it is not a
    // repeat; what it means is decided here.
    const offMessage = (channel.subscribeMessage ?? (() => () => {}))(
      (message) => inbound.handleMessage(message),
    )

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
      offSessionNames()
      offRunStream()
      offPriority()
      offAction()
      offMessage()
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
