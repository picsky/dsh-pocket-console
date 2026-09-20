/**
 * Which side the person is on, and therefore how long the desktop gets to answer first.
 *
 * The desktop head start is a bet that somebody is sitting at the desk. It is a good bet
 * until a person answers from the phone: at that moment they are at the phone, and waiting
 * out a head start for a desk nobody is at delays the only surface that can answer. So the
 * wait becomes zero, and this state is what the timers read instead of the setting.
 *
 * It goes back the other way when somebody answers *at the desk*, which is the only proof
 * that a person is there. A page that is merely open is not proof — a page left open is
 * this plugin's whole premise — so nothing about a browser being connected moves it.
 *
 * The state is durable because the alternative is worse: a restart would put a person who
 * is away back behind a head start, and the phone would go quiet exactly when it is the
 * only surface there is. It is kept in the credential store, which is where a
 * deployment already keeps what it must not lose across a restart.
 *
 * @module pocket-console/priority
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** The two sides, in the spelling the state route and the settings card use. */
export const DESK = 'desk'
export const PHONE = 'phone'

/** Credential record holding the side, under this plugin's namespace. */
const KEY = credentialKey('pocket-console', 'priority')

/**
 * Create the priority state.
 * @param options - the host context, the logger, the effective settings thunk, and the copy.
 * @returns reading, moving, and resolving the wait from the current side.
 */
export function createPriority({ ctx, log, settings, messages }) {
  /** The side in force. Starts at the desk, which is the documented default. */
  let side = DESK

  /**
   * What the last attempt to read the stored side found.
   *
   * A record the store refuses is reported once rather than on every change: the
   * deployment keeps working in memory either way, and a restart is what loses it.
   */
  let storedUnreadable = false

  /**
   * What to tell when the side moves.
   *
   * Kept here rather than reaching out to the machines that care, so this state knows nothing
   * about cards: whoever needs to react is told, and what they do about it is theirs.
   */
  const listeners = new Set()

  return {
    /** The side in force. */
    get: () => side,
    /**
     * Move to one side and remember it.
     *
     * Called with the side that has just proved itself: the phone when a decision came
     * from a card, the desk when the desktop branch of a race answered.
     * @param next - the side now in force.
     * @returns whether the side changed.
     */
    set(next) {
      if (next !== DESK && next !== PHONE) return false
      if (next === side) return false
      side = next
      log.info(side === PHONE ? messages().logPhonePriority : messages().logDeskPriority)
      for (const listener of listeners) {
        try {
          listener(side)
        } catch (error) {
          // A listener is a reaction, not the state: one that throws must not undo the move.
          log.warn(messages().logPriorityListenerFailed, error)
        }
      }
      void ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { side } }))
        .catch(error => { log.warn(messages().logPriorityStoreFailed, error) })
      return true
    },
    /**
     * Ask to be told when the side moves.
     * @param listener - called with the side now in force.
     * @returns the disposer removing the listener.
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /**
     * The wait one timer is actually counting down.
     *
     * This is the single place the settings value and the priority meet, so no timer has
     * to know which side the person is on.
     * @returns seconds the desktop may answer before the channel is used.
     */
    delaySeconds: () => (side === PHONE ? 0 : settings().delaySeconds),
    /**
     * Read the stored side back.
     *
     * Called once by the plugin while it is starting. A deployment that never moved sides
     * has nothing stored, and a store that refuses to answer leaves the desk default in
     * force rather than failing the load.
     * @returns resolution once the stored side has been applied or found absent.
     */
    async restore() {
      try {
        const record = await ctx.credentials.readRecord(KEY)
        const stored = record?.kind === 'grant' ? record.payload?.side : undefined
        if (stored === PHONE || stored === DESK) side = stored
      } catch (error) {
        if (!storedUnreadable) {
          storedUnreadable = true
          log.warn(messages().logPriorityRestoreFailed, error)
        }
      }
    },
  }
}
