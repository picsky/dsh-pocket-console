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

  return {
    /**
     * Open the domain and read back the notices that were live before this process.
     * @returns the stored notices, newest first; empty when storage is unavailable.
     */
    async open() {
      const facility = ctx.get?.('storageDomain')
      if (facility === undefined || typeof facility.open !== 'function') return []
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
          // schema rejects is then skipped instead of costing every other notice.
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
        return [...table.entries()]
          .map(([rid, value]) => ({ rid, ...value }))
          .sort((left, right) => right.sentAt - left.sentAt)
      } catch (error) {
        log.warn(messages().logNoticeStoreUnavailable, error)
        return []
      }
    },
    /**
     * Remember one live notice, so a later run can put it back.
     * @param notice - the rid, its session, the message, the session seq, and when.
     */
    async put(notice) {
      if (table === undefined) return
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
      if (table === undefined) return
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
      if (open === undefined) return
      try {
        await open.close()
      } catch (error) {
        log.warn(messages().logNoticeStoreWriteFailed, error)
      }
    },
  }
}
