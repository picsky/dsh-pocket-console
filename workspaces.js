/**
 * Which workspace each card on the phone belongs to, keyed by the message it lives in.
 *
 * A card's title is built from the record that owns it, and that record is in memory: after
 * a restart, a press that names no live request can rewrite the card it came from — the
 * press carries the message, and the message is enough to find the card — but there is no
 * record left to read a workspace from. The same gap opens the other way round for a notice
 * retired by a press rather than by its own rules.
 *
 * So the answer is kept beside the message instead: recorded when the card goes out, read
 * when a card has to be rewritten without its owner. It is deliberately not durable — this
 * is presentation for a card that is on its way to being retired, and a restart that loses
 * it costs a title its workspace, not a decision its meaning.
 *
 * The map is bounded because a deployment that stays up for weeks sends cards forever, and
 * nothing else retires an entry: forgetting the oldest is right, because a card nobody has
 * touched in that long is not about to be pressed.
 *
 * @module pocket-console/workspaces
 */

/** How many cards are remembered before the coldest is forgotten. */
const CAPACITY = 128

/**
 * Create the registry.
 * @returns recording a card's workspace, and reading one back.
 */
export function createWorkspaces() {
  /** Message handle to workspace label, in insertion order. */
  const byMessage = new Map()

  return {
    /**
     * Remember what one delivered card calls its session's workspace.
     * @param handle - the message the card lives in, as the channel reported it.
     * @param workspace - the label the card was titled with, when it had one.
     */
    record(handle, workspace) {
      if (typeof handle !== 'string' || handle === '' || workspace === undefined) return
      // Re-inserting moves an entry to the end, so the oldest key is always the first.
      byMessage.delete(handle)
      byMessage.set(handle, workspace)
      if (byMessage.size > CAPACITY) {
        byMessage.delete(byMessage.keys().next().value)
      }
    },
    /**
     * What one card on the phone calls its session's workspace.
     * @param handle - the message the card lives in.
     * @returns the label, or undefined when nothing was recorded for it.
     */
    lookup(handle) {
      return typeof handle === 'string' ? byMessage.get(handle) : undefined
    },
  }
}
