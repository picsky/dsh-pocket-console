/**
 * What each session's goal is doing, as the phone can see it.
 *
 * A session with an active goal keeps working long after the person stopped talking to it, and none
 * of that work reaches the phone. `dsh-goal-round-driver` starts each next round the moment the
 * agent goes idle: it renders a `<goal_round>` prompt and calls `agent.followup()` with
 * `source: { kind: 'goal', goalId, revision, round }` (`dsh-goal-round-driver/lib/index.js:123-154`).
 * The round is a turn like any other in the same session, and every card in this plugin is keyed on
 * "a person spoke" (`results.js:1062` sets its eligible flag, `activity.js:953` draws its run
 * boundary from it) — so the round leaves the card exactly where the previous one finished, and a
 * reader cannot tell a session that is still working from one that has stopped.
 *
 * The silence is not only the start of a round. The same driver **pauses** a goal whose round was
 * interrupted (`:213-236`), **blocks** it at the round cap with `code: 'round-limit'` (`:125-131`),
 * and the model **completes** it from inside the round that proved the work done. Those three are the
 * transitions a reader most needs — they are the ones after which nothing else happens on its own —
 * and without them "the goal stopped" and "the goal is on round seven" both look like "finished".
 *
 * **Read through the service, never parsed out of the prompt.** The round prompt carries the
 * objective and `Round: N/M` (`:14-17`), and reading those back would be a second implementation of
 * the host's own vocabulary, drifting the first time either side rewords it. `ctx.goals.get(agent)`
 * is the authority (`dsh-goal/lib/index.js:611`) and answers with
 * `{ id, revision, phase, activation, objective, maxGoalRounds, roundsStarted }`; the host's own
 * events say when to read it again. `get` throws for an agent that is not the registry's live
 * instance (`:767`), so every read here is defensive: a session whose agent is gone keeps what it was
 * last seen with, a session the service has no goal for is forgotten, and a session that could not be
 * asked at all keeps the last answer.
 *
 * **The panel that owns goals is optional.** `goals` is not part of the harness core, so this module
 * is inert until a deployment composes it: no round is recognised, no state is read, and every card
 * is byte-for-byte what it was before this module existed.
 *
 * @module pocket-console/goal
 */

import { clipToBytes } from './budget.js'

/**
 * How many sessions' goal state is remembered before the coldest is forgotten.
 *
 * The same bounded, least-recently-used discipline the workspace registry, the activity records and
 * the session names use: a deployment that stays up for weeks meets a lot of sessions, and the one
 * nobody has looked at for longest is the one to forget.
 */
const CAPACITY = 256

/**
 * How much of one objective is kept.
 *
 * An objective is a prompt a person wrote and can be arbitrarily long; it is 200 bytes here because
 * what a card says is one line of it. Clipped **on the way in** rather than at every render, so the
 * map's own footprint is bounded by the same number the card's is — the discipline `note()` already
 * uses for the entries of a run.
 */
const OBJECTIVE_BYTES = 200

/** How many goals the state route reports, newest first. A page polls that route. */
const REPORT_LIMIT = 8

/**
 * The line a card shows for one goal, or undefined when the state has nothing a card can say.
 *
 * The words live in the copy table because they are the deployment's own, and this is the one place
 * that decides *which* of them a phase and an activation add up to — so the two cards that draw a
 * goal line, and any card added later, cannot disagree about what a paused goal is called.
 *
 * A round number is what makes an active line worth reading, and every state a card is rendered for
 * has one: it is the number of the `<goal_round>` message that opened the run. A goal that exists
 * with no round started yet — `create` sets `roundsStarted: 0` — has no line, which is what the
 * undefined return says; that state belongs to the state route, not to a card.
 *
 * `blocked` is drawn as the round cap only when the counters say the cap is what stopped it. The
 * driver blocks for three reasons and the other two are incidents rather than a budget being spent.
 * @param state - one goal state, as {@link createGoals} carries it.
 * @param copy - the copy table in force.
 * @returns the line, or undefined.
 */
export function goalLine(state, copy) {
  if (state === undefined || state === null) return undefined
  if (state.phase === 'complete') return copy.goalComplete
  if (state.phase === 'paused') return copy.goalPaused
  if (state.phase === 'blocked') {
    return state.round >= state.maxRounds ? copy.goalAtRoundLimit : copy.goalBlocked
  }
  if (state.phase !== 'active') return undefined
  if (!(state.round > 0) || !(state.maxRounds > 0)) return undefined
  // An active goal that is not armed will not continue on its own: the host disarms one before a
  // driver unloads and after an error, and its own goal bar draws that as a different state
  // ("未运行的目标", `dsh-client-ui-goal/lib/client.js:167-170`). Claiming "自动继续" there would be
  // the one thing this module exists to stop — a card that promises work nothing is going to do.
  return state.activation === 'disarmed'
    ? copy.goalInactive(state.round, state.maxRounds)
    : copy.goalRunning(state.round, state.maxRounds)
}

/**
 * Create the goal reader.
 * @param options - the deployment's context, copy table, log, and diagnostics.
 * @returns following the goal state, and what a card and the state route read from it.
 */
export function createGoals({ ctx, messages, log, diagnostics = () => {} }) {
  /** The newest state per session, oldest key forgotten first. */
  const states = new Map()
  /** What to tell when a goal moves: the card module, which owns where a card is written. */
  const listeners = new Set()
  /** The goal service, once a deployment composes the panel that owns it. */
  let service

  /** Say that one session's goal moved, to whoever is drawing it. */
  const notify = (session) => {
    for (const listener of [...listeners]) {
      try {
        listener(session)
      } catch (error) {
        log?.warn?.(messages().logGoalListenerFailed, error)
      }    }
  }

  /**
   * One line of an objective, as a card and the state route carry it.
   *
   * Newlines collapse because a card line is a line: an objective is often several sentences, and the
   * second one would otherwise arrive as a paragraph under a line that is meant to be glanced at.
   * @param objective - the goal's objective, whatever the host handed over.
   * @returns the clipped line, or undefined when there is nothing to show.
   */
  const lineOf = (objective) => {
    const flat = String(objective ?? '').replace(/\s+/g, ' ').trim()
    return flat === '' ? undefined : clipToBytes(flat, messages().truncated, OBJECTIVE_BYTES)
  }

  /**
   * Remember one session's state, oldest key forgotten first.
   *
   * Re-inserted so the first key is the coldest one, but only while there is room to move it: at the
   * cap, moving a key that is already last would first remove it and then find no room to put it
   * back, which is how a live goal would be lost for good.
   * @param session - the session id.
   * @param state - the normalized state.
   */
  const remember = (session, state) => {
    if (states.size < CAPACITY) states.delete(session)
    else if (!states.has(session)) states.delete(states.keys().next().value)
    states.set(session, state)
  }

  /**
   * One host view as this module carries it.
   *
   * Only the fields a card and the route draw are kept, and the objective is clipped here rather than
   * at every render. `round` is undefined for a goal whose first round has not started; `goalLine`
   * is what decides that such a state has no line to draw.
   * @param view - the `GoalView` the service answered with.
   * @returns the normalized state.
   */
  const normalize = (view) => ({
    id: view?.id,
    revision: view?.revision,
    phase: view?.phase,
    activation: view?.activation ?? 'disarmed',
    round: Number.isInteger(view?.roundsStarted) && view.roundsStarted > 0 ? view.roundsStarted : undefined,
    maxRounds: Number.isInteger(view?.maxGoalRounds) ? view.maxGoalRounds : undefined,
    objective: lineOf(view?.objective),
  })

  /**
   * Read one session's current goal from the service.
   *
   * Three answers, and the difference between the last two is the whole reason this is not a plain
   * lookup: a state, **null** when the service answered that this session has no goal (which is how a
   * cleared or replaced goal is forgotten rather than kept alive by a stale map entry), and
   * **undefined** when the service could not be asked at all — no service composed, no live agent, or
   * the throw its own live-agent fence raises (`dsh-goal/lib/index.js:767`).
   * @param session - the session id.
   * @returns the state, null, or undefined.
   */
  const read = (session) => {
    if (service === undefined) return undefined
    const agent = ctx.get?.('agents')?.get?.(session)
    if (agent === undefined) return undefined
    let view
    try {
      view = service.get(agent)
    } catch (error) {
      // Expected whenever a session's agent has gone: the fence, or a projection that failed to
      // build. Neither is the phone's business, and neither may take the card down with it — but the
      // reason is said out loud, because a state that stops updating is otherwise invisible.
      log?.debug?.(messages().logGoalReadFailed(String(error?.message ?? error)))
      return undefined
    }
    return view === undefined || view === null ? null : normalize(view)
  }

  /** Whether two states differ in anything a card draws. */
  const differs = (left, right) => left === undefined
    || left.id !== right.id
    || left.phase !== right.phase
    || left.activation !== right.activation
    || left.round !== right.round
    || left.maxRounds !== right.maxRounds
    || left.objective !== right.objective

  /**
   * Re-read one session and remember it, telling the deployment when what a card draws moved.
   *
   * The notification is what carries the three silent transitions to a card that is already on the
   * phone: the driver blocks, pauses or completes a goal without the session appending anything a
   * card watches, so an event from the goal domain is the only thing that can move it.
   * @param session - the session id.
   * @returns the state now in force, or undefined when none is known.
   */
  const refresh = (session) => {
    const state = read(session)
    if (state === null) {
      const had = states.delete(session)
      if (had) notify(session)
      return undefined
    }
    // Could not be asked: what was last seen stays, and the card keeps saying it.
    if (state === undefined) return states.get(session)
    const before = states.get(session)
    remember(session, state)
    if (differs(before, state)) notify(session)
    return state
  }

  /**
   * The goal a `user/message` opened a round with, or undefined when it opened nothing.
   *
   * This is the boundary every card reads: the source the driver stamps
   * (`dsh-goal-round-driver/lib/index.js:134-142`) is the only thing that separates a round a machine
   * started from a person's own message, and both arrive as `user/message`.
   * @param event - one committed session event.
   * @returns the round number when there is one, otherwise undefined.
   */
  const roundOf = (event) => {
    if (service === undefined) return undefined
    if (event?.type !== 'user/message') return undefined
    const source = event.data?.source
    if (source?.kind !== 'goal') return undefined
    const round = Number.isInteger(source.round) && source.round > 0 ? source.round : undefined
    return { round }
  }

  return {
    /**
     * Start following the goal domain.
     *
     * The service arrives through `inject` rather than being read at load, so a deployment that
     * composes the goal panel later — or never — needs no ordering assumption from this plugin. The
     * listeners live on the plugin's own context, like every other listener here.
     * @returns the disposer removing the listeners.
     */
    install() {
      const offs = [
        ctx.on('session/event', (session, event) => {
          if (session?.id === undefined) return
          if (roundOf(event) === undefined) return
          refresh(session.id)
        }),
        // Every mutation the domain records: create, edit, pause, resume, block, complete and clear.
        // The payload carries the live agent, whose id is the session id (`dsh-goal` emits it
        // agent-scoped, `:877`).
        ctx.on('goal/changed', ({ agent }) => {
          if (agent?.id === undefined) return
          refresh(agent.id)
        }),
        // Arming and disarming are process-local rather than durable, and are not part of
        // `goal/changed`: they arrive with the session id alone (`:798-805`).
        ctx.on('goal/activation-changed', ({ sessionId }) => {
          if (sessionId === undefined) return
          refresh(sessionId)
        }),
      ]
      ctx.inject(['goals'], (goalCtx) => {
        goalCtx.effect(() => {
          service = goalCtx.goals
          diagnostics('目标：已接入宿主的 goal 服务，目标轮会画在卡片上。')
          return () => { service = undefined }
        }, 'pocket-console: goals')
      })
      return () => { for (const off of offs) off() }
    },
    /** Whether the goal panel is composed, and therefore whether any of this runs. */
    available: () => service !== undefined,
    /**
     * Follow every goal that moves, so a card already on the phone can be rewritten.
     *
     * The three transitions that end a goal — the round cap, a pause after an interrupted round, and
     * completion — append nothing to the session log a card watches, so this is the only thing that
     * can carry them. Wired here rather than handed in at construction because the module that draws
     * the card is built after this one, and a listener that has to exist at load is the shape that
     * makes load order matter.
     * @param listener - called with the session id whose goal moved.
     * @returns the disposer removing it.
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    roundOf,
    /**
     * The state to carry on a run a goal round opened, or undefined when this is not one.
     *
     * The round number is taken from the message itself rather than from the counters, and the
     * larger of the two wins: the fold that advances `roundsStarted` consumes the same session event
     * this listener does (`dsh-goal/lib/index.js:277-278`), so on the tick the event is seen the
     * counter may not have moved yet — and the message is the authority on which round it is anyway.
     * @param session - the session id.
     * @param event - the event that opened the round.
     * @returns the state with its round, or undefined.
     */
    mark(session, event) {
      const round = roundOf(event)
      if (round === undefined) return undefined
      const state = refresh(session) ?? states.get(session)
      if (state === undefined) return undefined
      const number = Math.max(round.round ?? 0, state.round ?? 0)
      return number > 0 ? { ...state, round: number } : undefined
    },
    /**
     * What is known about one session's goal, read from the map and otherwise asked for once.
     *
     * The fallback read is what keeps a card right for a session whose event this process never saw —
     * every session that already had a goal when the deployment started — which is the same shape
     * `session-names.js` uses for a name it never heard.
     * @param session - the session id.
     * @returns the state, or undefined when the session has no goal.
     */
    stateOf(session) {
      const known = states.get(session)
      if (known !== undefined) return known
      return refresh(session)
    },
    /** How many sessions' goals are remembered, for the suite and for diagnostics. */
    tracked: () => states.size,
    /**
     * The goals to report on the state route, newest first.
     *
     * Read live for every session the registry still has, so a page that was just opened — or a
     * deployment that was just restarted, whose map is empty — sees the goal without waiting for the
     * next event; the remembered states cover a session whose agent has gone. Nothing here writes:
     * this answers a polling route, and a route that moved cards would be a route with side effects.
     * @returns the bounded report.
     */
    report() {
      if (service === undefined) return { available: false, tracked: 0, goals: [] }
      const seen = new Map()
      for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
        const session = agent?.session?.id ?? agent?.id
        if (session === undefined) continue
        const state = read(session)
        if (state === undefined || state === null) continue
        seen.set(session, state)
      }
      const goals = []
      for (const [session, state] of [...states].reverse()) {
        if (!seen.has(session)) seen.set(session, state)
      }
      for (const [session, state] of [...seen].reverse()) {
        goals.push({ session, ...state })
        if (goals.length >= REPORT_LIMIT) break
      }
      return { available: true, tracked: states.size, goals }
    },
  }
}
