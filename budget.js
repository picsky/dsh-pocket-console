/**
 * How much text one card may carry, and how many elements it may hold.
 *
 * The documentation says a card is capped at 30 KB. **It is not**, and building to that number is
 * what made every long history truncated: measured against the real tenant with this deployment's own
 * app, `im.message.create` accepted a **131 KB** body and `im.message.patch` accepted 98 KB, both far
 * past the documented figure. What the platform does enforce is measured here as well, and there are
 * two ceilings rather than one:
 *
 * | Limit | Accepted | Refused | Code |
 * |---|---|---|---|
 * | Elements in a card | 180 | 200 | `230099`, `element exceeds the limit` |
 * | Plain text, Chinese | 51,000 chars | 51,300 | `230025` |
 * | Plain text, Latin | 120,000 chars | 200,000 | `230025` |
 * | Plain text, emoji | 20,000 | 40,000 | `230025` |
 * | Request body as sent | 131 KB | 164 KB | `230025` |
 *
 * The text limits are counted by the platform on the content it decodes, not on the escaped body —
 * which is why Latin reaches five times what Chinese does. No single figure fits all four, so the
 * budget is set **below the lowest measured refusal** with room to spare, and {@link bodyBytes}
 * counts UTF-8 bytes, which is above the Latin cost and below the Chinese one.
 *
 * `CARD_TEXT_BUDGET` is therefore 32 KB: about 4.8× the smallest measured refusal when read as
 * Chinese text, and 3.7× the largest measured refusal when read as bytes. `CARD_ELEMENT_BUDGET` is
 * 120 against a measured 180, because a card that renders everything and is refused says nothing at
 * all — and the refusal is silent to a reader, who only sees no card.
 *
 * Both are budgets for **one card**, structure included: the title, the rule, the fold, the reply
 * form and the buttons come out of the same element count.
 *
 * @module pocket-console/budget
 */

/** Bytes of card text one message may carry, counted the way {@link bodyBytes} counts. */
export const CARD_TEXT_BUDGET = 32 * 1024

/**
 * How many elements one card may hold, across its whole body.
 *
 * Set below the platform's own ceiling so that a card which needs its full text still has somewhere
 * to put its structure: title, rule, fold, form and buttons share this count with the text.
 */
export const CARD_ELEMENT_BUDGET = 120

/**
 * What one string costs in the request body that ultimately carries it.
 *
 * The text's own bytes, plus one extra byte for each character the card's JSON has to escape and
 * one less than that for each it does not — which is `JSON.stringify`'s output without the quotes
 * it wraps around the result. That is the first of the body's two escapes, charged in full; the
 * budget's remaining headroom is what covers the second, under the worst case that every byte of
 * the card doubles again.
 * @param value - the text to measure.
 * @returns the bytes it may cost in the request body.
 */
export function bodyBytes(value) {
  return Math.max(0, Buffer.byteLength(JSON.stringify(String(value ?? '')), 'utf8') - 2)
}

/**
 * Platform codes that mean the card was refused for its size.
 *
 * Codes are checked alongside the wording because they are what the platform
 * actually promises: `230025` is the documented one for a card payload over the
 * limit, and the others are the neighbouring "content too long" refusals.
 */
const SIZE_CODES = new Set([230025, 230020, 230002, 10002])

/**
 * Whether a delivery failure reads as the platform refusing the card's size.
 *
 * The exact wording differs per surface and per locale, so the wording test is a
 * heuristic by necessity — but a refusal is not: it arrives as an envelope with a
 * `code` and a `msg`, and a card refused for size is retried by halving. This only
 * decides whether that one cheap retry happens: a wrong guess costs one smaller
 * card, and a missed guess leaves a card that never arrives.
 * @param error - the failure the channel raised.
 * @returns whether halving the text is worth one retry.
 */
export function looksLikeSizeRefusal(error) {
  const code = Number(error?.code ?? error?.response?.data?.code)
  if (SIZE_CODES.has(code)) return true
  const parts = [
    error?.message,
    error?.msg,
    error?.response?.data?.msg,
    // The SDK sometimes carries the whole envelope inside the message text, which is the only
    // place the platform's own wording appears when it threw before a body was parsed.
    typeof error === 'string' ? error : '',
  ]
  // Deliberately not `String(error)`: an SDK error's `toString` omits the response body, which is
  // where the reason lives. The message is joined with the parts above instead.
  const message = parts.filter(part => typeof part === 'string').join(' ')
  return /size|too large|too long|too many bytes|length|exceed|payload/i.test(message)
}

/**
 * The most of a marker that fits inside a budget, on a code-point boundary.
 *
 * A marker wider than the budget cannot be appended and still fit, and the caller asked for a bound
 * that has to hold: so the marker is what gets cut, and the result is the marker's own head rather
 * than the text's. Returning the marker unchanged would break the bound, and recursing into
 * {@link clipToBytes} to cut it would arrive back at this same case forever.
 * @param marker - the marker that did not fit.
 * @param budget - the budget it has to fit in.
 * @returns as much of the marker as fits.
 */
function markerWithin(marker, budget) {
  let used = 0
  let kept = ''
  for (const character of String(marker ?? '')) {
    const size = bodyBytes(character)
    if (used + size > budget) break
    used += size
    kept += character
  }
  return kept
}

/**
 * Cut text to a byte budget, on a code-point boundary.
 *
 * The budget is counted the way the request body will count it ({@link bodyBytes}), and the marker
 * is charged against it, so a clipped value never ends up larger than the caller asked for.
 * @param value - untrusted text from a request.
 * @param marker - what to append when the text did not fit.
 * @param budget - the byte budget, defaulting to {@link CARD_TEXT_BUDGET}.
 * @returns the text, clipped to the budget.
 */
export function clipToBytes(value, marker, budget = CARD_TEXT_BUDGET) {
  const text = String(value ?? '')
  if (bodyBytes(text) <= budget) return text

  const markerSize = bodyBytes(marker)
  // A marker wider than the budget cannot be appended and still fit: the caller asked
  // for a bound this marker cannot express, so the marker is what gets clipped rather
  // than the result silently exceeding the bound it promised.
  if (markerSize >= budget) return markerWithin(marker, budget)

  const room = budget - markerSize
  let used = 0
  let kept = ''
  // `for…of` walks code points, so a surrogate pair is never split in half.
  for (const character of text) {
    const size = bodyBytes(character)
    if (used + size > room) break
    used += size
    kept += character
  }
  return `${kept}${marker}`
}

/**
 * Cut text to a byte budget from the front, keeping its end.
 *
 * The counterpart of {@link clipToBytes} for text whose end is the part that matters — a record of
 * what a run did, where a reader wants how it finished rather than how it began. The marker goes
 * first, where the missing part was.
 * @param value - untrusted text from a request.
 * @param marker - what to prepend when the text did not fit.
 * @param budget - the byte budget, defaulting to {@link CARD_TEXT_BUDGET}.
 * @returns the text, clipped to the budget.
 */
export function clipTailToBytes(value, marker, budget = CARD_TEXT_BUDGET) {
  const text = String(value ?? '')
  if (bodyBytes(text) <= budget) return text

  const markerSize = bodyBytes(marker)
  if (markerSize >= budget) return markerWithin(marker, budget)

  const room = budget - markerSize
  // Walked backwards over code points: `for…of` cannot run in reverse, so the characters are
  // collected to the end of a reversed walk. A surrogate pair is still never split, because the
  // walk yields whole code points either way.
  const kept = []
  let used = 0
  for (const character of [...text].reverse()) {
    const size = bodyBytes(character)
    if (used + size > room) break
    used += size
    kept.unshift(character)
  }
  return `${marker}${kept.join('')}`
}

