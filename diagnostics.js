/**
 * Where the plugin says what it decided about a card, when a deployment asks it to.
 *
 * Every failure this plugin has had that took a long time to find had the same shape: **a branch that
 * said nothing.** A reply whose card is not rewritten, a card held back because the desk has the
 * person, a notice that never fires, a write given up on — from the phone they all look like "nothing
 * happened", and the log agrees, because the code that decided not to act wrote no line. The
 * information was never missing; it was never spoken.
 *
 * So this is one gate with one sentence per decision, off unless a deployment turns it on. Two things
 * about it are deliberate:
 *
 * - **Off by default.** A plugin that narrated every decision all the time would bury its own
 *   warnings in its own noise, and the warnings are the part that must always be visible. What is
 *   gated here is the *explanation*, never the *failure*: a failed rewrite is still a warning with or
 *   without this.
 * - **It gates the plugin, not the host.** Cordis exporters decide which levels reach a terminal, so
 *   a deployment that wants these lines also has to run its logger at `debug`. Two switches, because
 *   a plugin should not get to decide how loud its host is.
 *
 * @module pocket-console/diagnostics
 */

/**
 * Create the diagnostic gate for one deployment.
 * @param options - the resolved settings, the logger, and the copy.
 * @returns a function that speaks only when the deployment asked it to.
 */
export function createDiagnostics({ settings, log, messages }) {
  /**
   * Say what was decided, when the deployment asked to hear it.
   *
   * Never a failure: a caller with something to report as a problem has `log.warn` for it, which
   * stays visible either way. This is the other half — why a card was *not* touched, which is the
   * half nothing used to say.
   * @param line - what was decided, already spelled out.
   */
  return function said(line) {
    if (settings().debug !== 'on') return
    log.debug(`pocket-console: ${line}`)
  }
}
