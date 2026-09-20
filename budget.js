/**
 * How much text one card may carry.
 *
 * Feishu caps a card message's request body at 30 KB, and the body is larger than the text it
 * carries. The text is escaped once into the card JSON — a quote or a backslash doubles, a control
 * character costs six bytes — and the card JSON is then escaped again to become the request's
 * `content` parameter, doubling whatever was already doubled. Measured here: 4,600 characters of
 * `\"` is a 4.6 KB string, a 9.2 KB card, and an 18.5 KB body. Text dense in those characters is
 * not exotic; it is tool output, JSON, and code, which is much of what a run says.
 *
 * The budget is counted once through {@link bodyBytes}, and what makes that sufficient is the
 * headroom left underneath it: the worst text this admits becomes about 9 KB of card JSON, which
 * is 18 KB of body even if every byte of it doubles again. Thirty is the cap. Counting twice over
 * instead would charge a Chinese character six bytes for a doubling that never happens to it —
 * `JSON.stringify` leaves non-ASCII alone — and would halve what every card can say to buy room
 * that is already there.
 *
 * The cost is length in the ordinary case: about 1,500 Chinese characters, or 4,600 of Latin text.
 * A truncated card still says that it truncated, and still carries its buttons.
 *
 * @module pocket-console/budget
 */

/** Bytes of card text one message may carry, counted the way {@link bodyBytes} counts. */
export const CARD_TEXT_BUDGET = 4_608

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

