/**
 * The Host half of the desktop mirror.
 *
 * A forwarded request can only be finished by a browser answering it: the
 * gateway settles one from the client's result and pushes its cancel frame to the
 * clients it delivered to. So a request the phone answered leaves the desktop
 * composer waiting. This module carries the decision across that gap — the
 * browser half reads what is recorded here and replays it through the same
 * client call a click makes.
 *
 * It also keeps what the browser half reported doing, because whether a composer
 * closed is only observable in the page: a mirror that is not landing says which
 * step it reached.
 *
 * What that costs when nobody collects it is this module's second job. A browser
 * whose timers were frozen — a sleeping machine, a background tab — can miss the
 * whole window, and the composer it was meant to close then waits forever behind
 * a card that has already been answered. A lapsed decision therefore keeps being
 * offered, marked `expired`, so a late poll can say what happened instead of
 * reading "nothing" and finding nothing wrong.
 *
 * @module pocket-console/mirror
 */

/** How many reports the state route keeps for diagnosis. */
const REPORT_HISTORY = 20

/**
 * Create the mirror record.
 * @param options - the logger, the effective settings thunk, the copy thunk, and the clock.
 * @returns recording, reporting, and the state-route fields.
 */
export function createMirror({ log, settings, messages = () => ({}), now = () => Date.now() }) {
  /** The last decision the phone took, with the session it belongs to. */
  let decision = null
  /** What the browser half did with each decision, newest last. */
  const reports = []
  /** The decision whose lapse has already been reported, so it is said once. */
  let lapsed = null

  /** Whether a decision was carried across the gap by some browser. */
  const collected = (id) => reports.some(report => report.status === 'applied' && report.syncId === id)

  return {
    /**
     * Record the decision a request settled with, for the browser half to mirror.
     * @param record - the escalation the phone answered.
     * @param answer - the value the request settled with.
     */
    record(record, answer) {
      decision = {
        id: record.id,
        kind: record.kind,
        sessionId: record.request.agent?.id,
        questions: (record.request.questions ?? []).map(item => item.id),
        answer,
        at: now(),
      }
    },
    /**
     * Accept one browser-half report.
     * @param body - what the browser half did: status, and why when it could not.
     * @returns the accepted report.
     */
    report(body) {
      const report = {
        at: now(),
        status: typeof body?.status === 'string' ? body.status : 'unknown',
        ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body?.syncId === 'string' ? { syncId: body.syncId } : {}),
      }
      reports.push(report)
      if (reports.length > REPORT_HISTORY) reports.shift()
      // The decision has been carried across the gap it existed for, so it stops
      // being offered. Without this a reload, or a second tab, finds the same
      // decision still pending and replays an answer onto a request that is
      // already settled — which fails on every poll, forever.
      if (report.status === 'applied' && report.syncId === decision?.id) decision = null
      // The state route carries these; the deployment log only needs them when
      // someone asks, since a page load alone produces several.
      log.debug(messages().logMirror?.(report.status, report.reason) ?? report.status)
      return report
    },
    /**
     * The mirror fields of the state route.
     *
     * A decision inside its window is offered as it stands. One whose window has
     * passed is offered once more, marked `expired`: the composer it should have
     * closed is still waiting somewhere, and this is the only moment anything can
     * learn that. It is dropped only once a browser has said it saw it — which for
     * an expired decision is a report, not a mirror — so no reload can find it
     * again, and quiet, because the answer the model received is already the
     * phone's either way.
     * @returns the decision, while it is offered, and the recent reports.
     */
    state() {
      if (decision === null) return { sync: null, mirror: [...reports] }
      const ttl = settings().mirrorTtlSeconds * 1000

      if (now() - decision.at <= ttl) {
        return { sync: decision, mirror: [...reports] }
      }

      // A browser already carried this one across, so there is nothing left to
      // say about it and nothing left to offer.
      if (collected(decision.id)) {
        decision = null
        return { sync: null, mirror: [...reports] }
      }

      if (lapsed !== decision.id) {
        lapsed = decision.id
        // The one event that was invisible: a decision the phone took that no
        // browser ever came for, leaving a composer waiting behind it.
        log.warn(messages().logMirrorLapsed ?? 'a phone decision lapsed before any browser collected it')
      }
      return { sync: { ...decision, expired: true }, mirror: [...reports] }
    },
  }
}
