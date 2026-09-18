/**
 * Where live result notices are kept between runs.
 *
 * A notice promises to keep taking replies until the session it reports on moves
 * on — there is no time limit, and coming back tomorrow is the point. The registry
 * that decides that lived only in memory, so restarting turned every outstanding
 * notice into "expired": the reader lost a card they had been told to come back to,
 * and the card gave a reason that was not true. This keeps the live notices in the
 * durable storage hub and hands them back at startup, so the rules that retire a
 * notice can be applied again instead of being forgotten.
 *
 * Nothing here may break a notice. A deployment without the storage service keeps
 * the previous behaviour, and a storage failure is logged rather than thrown: a card
 * that cannot be remembered is still a card that works until the process ends.
 *
 * @module pocket-console/notice-store
 */

/** The domain this plugin owns in the storage hub. Names are lowercase alphanumeric. */
const DOMAIN = 'pocket_console'
/** The one table it declares, keyed by the notice's rid. */
const NOTICES = 'notices'
/** How many notices a restart brings back before the oldest are retired. */
export const RESTORE_LIMIT = 32

/**
 * Create the durable notice registry.
 * @param options - the plugin context, the logger, and the copy thunk.
 * @returns opening, remembering, forgetting, and closing the store.
 */
export function createNoticeStore({ ctx, log, messages }) {
  /** The open domain, once storage has been reached. */
  let domain
  /** The notices table, or undefined while storage is unavailable. */
  let table
  /** Set once the medium refused, so a broken domain is not retried on every notice. */
  let refused = false
  /** Set once the missing service has been reported, so it is reported once. */
  let reportedAbsent = false
  /** The open in flight: two callers must not open one domain twice. */
  let opening

  /**
   * Reach the durable medium, opening it the first time anything needs it.
   *
   * Deliberately not tied to a startup path. The storage service is provided inside
   * another plugin's own activation and can therefore appear *after* this one loads;
   * while the store waited for that, every write before it was a silent no-op — the
   * whole feature was dead, with nothing in the log to say so. A store that opens on
   * first use cannot be starved that way.
   *
   * Concurrent callers share one open. A domain may be open once, and the two triggers
   * that ask for this can arrive together.
   * @returns whether the notices table is open and usable.
   */
  async function ensureOpen() {
    if (table !== undefined) return true
    if (opening !== undefined) return await opening
    const facility = ctx.get?.('storageDomain')
    if (facility === undefined || typeof facility.open !== 'function') {
      if (!reportedAbsent) {
        reportedAbsent = true
        log.info(messages().logNoticeStoreAbsent)
      }
      return false
    }
    // A service that is merely late is tried again; a medium that refused is not.
    if (refused) return false
    opening = openDomain(facility)
    try {
      return await opening
    } finally {
      opening = undefined
    }
  }

  /**
   * Open the domain once and take the notices table.
   * @param facility - the mounted storage facility.
   * @returns whether the table is now usable.
   */
  async function openDomain(facility) {
    try {
      // Imported only once the service is known to be there. The service is provided
      // by this package, so a deployment that has the service has the package — and a
      // deployment without it resolves neither one, instead of failing to load.
      const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
      const { z } = await import('zod')
      const spec = defineDomain({
        name: DOMAIN,
        version: 1,
        // One document per notice: they are individually disposable, and a record the
        // schema rejects is then skipped instead of costing every other notice. The key
        // becomes a path segment under this layout, which is why the rid is drawn from
        // the path-safe grammar `noticeId` uses — a test pins that.
        layout: 'per-record',
        invalidRecords: 'backup-and-skip',
        tables: {
          [NOTICES]: domainTable(z.object({
            /** The session whose result the card reports. */
            session: z.string(),
            /** The message the card lives in, for rewriting it later. */
            handle: z.string().optional(),
            /** The session's last event when the card went out, when readable. */
            seq: z.number().optional(),
            /** When the card went out, for ordering and for the restore cap. */
            sentAt: z.number(),
          })),
        },
      })
      domain = await facility.open(spec)
      table = domain.table(NOTICES)
      // Diagnostic rather than news: a working store is what a deployment should expect,
      // and a startup that announces it would say something every time.
      log.debug(messages().logNoticeStoreReady)
      return true
    } catch (error) {
      refused = true
      log.warn(messages().logNoticeStoreUnavailable, error)
      return false
    }
  }

  return {
    /** Reach the medium, so a caller can tell "late" from "never". */
    ensureOpen,
    /** Whether the medium has been reached and the store can be read. */
    isOpen: () => table !== undefined,
    /**
     * Whether this deployment has no medium to reach at all.
     *
     * Distinct from "not open yet": a deployment composing no storage service will never
     * hold a record, so what it cannot show is genuinely not there. A medium that is merely
     * slow has not answered that question and must not be treated as though it had.
     * @returns whether storage is absent or has refused.
     */
    unavailable: () => refused || reportedAbsent,
    /**
     * Read back the notices that were live before this process.
     * @returns the stored notices, newest first; empty when storage is unavailable.
     */
    async open() {
      if (!await ensureOpen()) return []
      return [...table.entries()]
        .map(([rid, value]) => ({ rid, ...value }))
        .sort((left, right) => right.sentAt - left.sentAt)
    },
    /**
     * Remember one live notice, so a later run can put it back.
     * @param notice - the rid, its session, the message, the session seq, and when.
     */
    async put(notice) {
      if (!await ensureOpen()) return
      try {
        await table.put(notice.rid, {
          session: String(notice.session),
          ...(notice.handle === undefined ? {} : { handle: String(notice.handle) }),
          ...(notice.seq === undefined ? {} : { seq: notice.seq }),
          sentAt: notice.sentAt,
        })
      } catch (error) {
        log.warn(messages().logNoticeStoreWriteFailed, error)
      }
    },
    /**
     * Forget one notice, durably.
     *
     * Called wherever a notice stops being live — consumed, superseded, or retired —
     * so that a reply can never be replayed from a card the process already answered.
     * @param rid - the notice's id.
     */
    async remove(rid) {
      if (!await ensureOpen()) return
      try {
        await table.delete(rid)
      } catch (error) {
        log.warn(messages().logNoticeStoreWriteFailed, error)
      }
    },
    /** Release the domain. The records stay: that is what the next run reads. */
    async close() {
      const open = domain
      domain = undefined
      table = undefined
      refused = false
      if (open === undefined) return
      try {
        await open.close()
      } catch (error) {
        log.warn(messages().logNoticeStoreWriteFailed, error)
      }
    },
  }
}
