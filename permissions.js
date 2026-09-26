/**
 * The deployment's permission presets, as far as a plugin may use them.
 *
 * DSH owns permissions, and it owns them through **one** product-level switch:
 * `ctx.permissionPresets` bundles a sandbox mode with an approval policy, and the shipped table
 * contains `danger-full-access` — no confinement, and the `never` policy on top. That is the whole of
 * "full permission", and it is deliberately not something a plugin may invent:
 *
 * - The outcome vocabulary is closed (`allowed-once | rejected | cancelled | unavailable`), and
 *   `allowed-once` is the only grant. There is no `allow-always`, no remembered rule, no grant store.
 * - `never` **short-circuits before the approval waterfall**, so a session on full access does not
 *   reach this plugin at all. Nothing is approved behind the reader's back; the requests simply stop,
 *   and any that still ask are refused.
 *
 * **Why this is not "the plugin approves everything".** A plugin that answered every request with
 * `allowed-once` would write the same audit line a human click writes — `approval/decided` carries
 * `{ id, outcome }` and no actor — so the log would claim a person decided. Switching a preset writes
 * `permission/preset` + `sandbox/mode` + `approval/policy` instead: three durable session events that
 * say *a person chose this policy*. Same automatic outcome, honest record.
 *
 * This module is the thin, testable seam: it reads the preset that means full access (by its bundle,
 * never by its name), reads a session's current preset, and switches one. It never throws at the
 * caller — a host without the service, or a switch the service refuses, is reported as `undefined` /
 * `false`, which is what makes the card degrade to its two buttons instead of breaking.
 *
 * @module pocket-console/permissions
 */

/**
 * The knob bundle that means "no confinement, no asking".
 *
 * Matched by value rather than by name: a deployment may call its presets anything, and the label the
 * reader sees comes from the deployment's own catalog.
 */
const FULL_ACCESS = { sandbox: 'danger-full-access', approval: 'never' }

/**
 * Read the deployment's permission presets.
 * @param options - the host context, the logger and the copy.
 * @returns reading the full-access preset, reading a session's preset, and switching one.
 */
export function createPermissions({ ctx, log, messages }) {
  /** The service, when this host composes one. Older hosts do not. */
  const service = () => ctx?.get?.('permissionPresets')

  return {
    /**
     * The configured preset that means full access, if the deployment offers one.
     * @returns its name and the label the deployment gives it, or undefined.
     */
    fullAccess() {
      const presets = service()
      if (presets === undefined) return undefined
      if (typeof presets.catalog !== 'function' || typeof presets.resolve !== 'function') return undefined
      try {
        for (const option of presets.catalog().options ?? []) {
          const spec = presets.resolve(option.value)
          if (spec?.sandbox === FULL_ACCESS.sandbox && spec?.approval === FULL_ACCESS.approval) {
            // The option's own label first: a deployment that renamed the preset gets its name on the
            // card, and the browser half and the phone then say the same word for the same thing.
            return { name: option.value, label: option.name ?? option.value }
          }
        }
      } catch (error) {
        log?.warn?.(messages().logFullAccessFailed, error)
        return undefined
      }
      return undefined
    },
    /**
     * The preset one session is on right now, for the card's own line.
     * @param session - the session to read.
     * @returns the preset's name, or undefined when it cannot be read.
     */
    current(session) {
      const presets = service()
      if (presets === undefined || session === undefined || typeof presets.current !== 'function') return undefined
      try {
        return presets.current(session)
      } catch {
        // A session whose projection is missing is a session we cannot describe, not a failure worth
        // a line: the card simply does not name a permission.
        return undefined
      }
    },
    /**
     * Switch one session to a preset, which is the one call that writes the three durable knob events.
     * @param session - the session to switch.
     * @param name - the preset to switch to.
     * @returns whether the switch was accepted.
     */
    set(session, name) {
      const presets = service()
      if (presets === undefined || session === undefined || typeof presets.set !== 'function') return false
      try {
        presets.set(session, name)
        return true
      } catch (error) {
        log?.warn?.(messages().logFullAccessFailed, error)
        return false
      }
    },
  }
}
