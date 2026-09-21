/**
 * Where the plugin says what it decided about a card, when a deployment asks it to.
 *
 * Every failure this plugin has had that took a long time to find had the same shape: **a branch that
 * said nothing.** A reply whose card is not rewritten, a card held back because the desk has the
 * person, a notice that never fires, a write given up on — from the phone they all look like "nothing
 * happened", and the log agrees, because the code that decided not to act wrote no line. The
 * information was never missing; it was never spoken.
 *
 * So this is one gate with one sentence per decision, and it speaks through **two** outlets on
 * purpose:
 *
 * - the deployment's logger, where it belongs; and
 * - a file of its own, because the logger is not this plugin's to configure. Cordis lets an exporter
 *   set a per-name level and defaults to `info`, so `log.debug` reaches a terminal only when the
 *   *host* was started to show debug — which means a switch documented as "turn this on to see why"
 *   would, on a default deployment, show nothing at all. A switch with no visible output is worse
 *   than no switch: it teaches the reader that the plugin has nothing to say.
 *
 * Two properties are deliberate:
 *
 * - **Off by default.** A plugin that narrated every decision all the time would bury its own
 *   warnings in its own noise, and the warnings are the part that must always be visible. What is
 *   gated here is the *explanation*, never the *failure*: a failed rewrite is still a warning with or
 *   without this.
 * - **A failed write is not an error.** Diagnostics that could break the thing they are describing
 *   would be the worst possible trade, so the file outlet swallows its own failures.
 *
 * @module pocket-console/diagnostics
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The file the diagnostics go to, beside the rest of this deployment's state.
 *
 * Resolved the way the harness resolves its own home: `$DSH_HOME` when set, `~/.dsh` otherwise. Named
 * after the deployment's own copy of that path rather than read from a service, because the plugin
 * must be loadable in a deployment that composes no such service.
 * @param environment - the process environment.
 * @returns the absolute path of the debug log.
 */
export function debugLogPath(environment = process.env) {
  const home = environment.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'pocket-console-debug.log')
}

/**
 * Create the diagnostic gate for one deployment.
 * @param options - the resolved settings, the logger, and the file to write to.
 * @returns a function that speaks only when the deployment asked it to.
 */
export function createDiagnostics({ settings, log, path = debugLogPath() }) {
  /**
   * Say what was decided, when the deployment asked to hear it.
   *
   * Never a failure: a caller with something to report as a problem has `log.warn` for it, which
   * stays visible either way. This is the other half — why a card was *not* touched, which is the
   * half nothing used to say.
   * @param line - what was decided, already spelled out.
   */
  const said = (line) => {
    if (settings().debug !== 'on') return
    log.debug(`pocket-console: ${line}`)
    try {
      appendFileSync(path, `${new Date().toISOString()}  ${line}\n`, 'utf8')
    } catch {
      // The logger already has it. A diagnostic that can break the run it is describing is a worse
      // trade than a diagnostic that is occasionally missing, so a file this process cannot write to
      // is not worth a warning of its own — that would be noise about the noise.
    }
  }

  // Announced once at load, so the file's first line answers the two questions a reader opens it
  // with: is this deployment actually in debug mode, and is this the file it writes to. A load that
  // happens while the switch is off leaves no line and creates no file, which is itself the answer —
  // the switch belongs to the deployment, and a deployment that never turned it on gets no file.
  said(`调试模式已开启，后续每一条决定都会写到这里：${path}`)

  return said
}
