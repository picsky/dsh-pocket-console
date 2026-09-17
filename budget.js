/**
 * How much text one card may carry.
 *
 * Feishu caps a card message's request body at 30 KB. The card's own structure —
 * title, elements, buttons, forms, the schema 2.0 wrapper — costs about 1 KB, and
 * a CJK character costs three bytes in UTF-8 (Latin one), so the budget has to be
 * counted in bytes: a character limit silently means three times the payload in
 * Chinese.
 *
 * Nine kilobytes of text keeps a whole card near 10 KB, a third of the cap. That
 * is far more than an approval reason or a question detail needs, and enough for
 * the head of a long plan, so truncation stays the exception it should be.
 *
 * @module pocket-console/budget
 */

/** Bytes of card text one message may carry. */
export const CARD_TEXT_BUDGET = 9 * 1024

/**
 * Whether a delivery failure reads as the platform refusing the card's size.
 *
 * The exact wording differs per surface and per locale, so this is a heuristic by
 * necessity. It only decides whether one cheap retry happens: a wrong guess costs
 * one duplicate attempt, and a missed guess leaves the budget doing its job.
 * @param error - the failure the channel raised.
 * @returns whether halving the text is worth one retry.
 */
export function looksLikeSizeRefusal(error) {
  const message = String(error?.message ?? error)
  return /size|too large|too long|too many bytes|length|exceed|payload/i.test(message)
}

/**
 * Cut text to a byte budget, on a code-point boundary.
 *
 * The marker is charged against the budget, so a clipped value never ends up
 * larger than the caller asked for.
 * @param value - untrusted text from a request.
 * @param marker - what to append when the text did not fit.
 * @param budget - the byte budget, defaulting to {@link CARD_TEXT_BUDGET}.
 * @returns the text, clipped to the budget.
 */
export function clipToBytes(value, marker, budget = CARD_TEXT_BUDGET) {
  const text = String(value ?? '')
  if (Buffer.byteLength(text, 'utf8') <= budget) return text

  const room = budget - Buffer.byteLength(marker, 'utf8')
  let used = 0
  let kept = ''
  // `for…of` walks code points, so a surrogate pair is never split in half.
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > room) break
    used += size
    kept += character
  }
  return `${kept}${marker}`
}
