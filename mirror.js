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
 * @module pocket-console/mirror
 */

/** How many reports the state route keeps for diagnosis. */
const REPORT_HISTORY = 20

/**
 * Create the mirror record.
 * @param options - the logger, the effective settings thunk, and the clock.
 * @returns recording, reporting, and the state-route fields.
 */
export function createMirror({ log, settings, now = () => Date.now() }) {
  /** The last decision the phone took, with the session it belongs to. */
  let decision = null
  /** What the browser half did with each decision, newest last. */
  const reports = []

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
      // The state route carries these; the deployment log only needs them when
      // someone asks, since a page load alone produces several.
      log.debug(`桌面镜像：${report.status}${report.reason === undefined ? '' : `（${report.reason}）`}`)
      return report
    },
    /**
     * The mirror fields of the state route.
     * @returns the decision while it is still current, and the recent reports.
     */
    state() {
      const ttl = settings().mirrorTtlSeconds * 1000
      return {
        sync: decision !== null && now() - decision.at <= ttl ? decision : null,
        mirror: [...reports],
      }
    },
  }
}
