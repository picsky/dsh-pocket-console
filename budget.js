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
 * | Tables in a card | 5 | 6 | `230099`, `card table number over limit` |
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
 * Bytes of the whole request body one card may cost.
 *
 * The other two budgets bound a card part by part: each string on its own, and how many elements
 * there may be. Neither bounds the body, and the body is what the platform refuses — so between them
 * they leave a hole big enough to matter. Measured rather than reasoned: {@link CARD_ELEMENT_BUDGET}
 * elements each holding a string at the full {@link CARD_TEXT_BUDGET} extrapolates to roughly **11
 * MB**, against a measured refusal at **164 KB**. Nothing a caller builds today comes close — the
 * suite's real cards weigh 0.7–10 KB — so this is not a live bug; it is the ceiling the per-part
 * budgets do not rule out, bounded on purpose instead of by luck.
 *
 * Set at 96 KB: comfortably under the **131 KB** this tenant accepted, with 42% of room below the
 * **164 KB** it refused, and about ten times the largest card ever observed. A budget closer to the
 * ceiling would buy nothing, because the content that would use it does not exist; one further below
 * would start clipping cards that arrive fine today.
 */
export const CARD_BODY_BUDGET = 96 * 1024

/**
 * How many Markdown tables one card may carry.
 *
 * Counted by the platform **across the whole card** — body and fold together — and refused at six
 * with `230099 / ErrCode: 11310 / ErrMsg: card table number over limit`, measured on 2026-09-26
 * against this deployment's own tenant: five arrived, six were refused, and the nine-table answer
 * that started this arrived not at all. The documented "at most four per richtext component" is not
 * what the service enforces (five tables inside one element arrived and rendered in full), so the
 * only ceiling that matters is the card-wide five, and this budget sits one below it.
 */
export const CARD_TABLE_BUDGET = 4

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
 * What kind of refusal the platform reported, and what it is worth doing about it.
 *
 * Codes alone are not enough — `230099` is an envelope whose reason lives in its `msg`
 * ("card table number over limit", "element exceeds the limit", …) — and wording alone is not
 * enough either, because some codes are not about the card at all. Both are read here, and the
 * answer is a **kind** rather than a yes/no, because the three card-shaped refusals need three
 * different degradations.
 *
 * The set of codes this used to carry ({@link SIZE_CODES}) was wrong in three of its four entries:
 * `230020` is a frequency limit, `230002` is "the bot is not in the group" and `10002` is "the bot
 * is not in the chat" — none of them is a size refusal — while `230099`, the code that actually
 * refuses a card, was not in the set at all. Halving a card for a rate limit wastes a send, and
 * missing a table refusal loses the card entirely (issue #74).
 *
 * @param error - the failure the channel raised.
 * @returns the kind (`tables` / `elements` / `size` / `content` / `frequency` / `other`), the
 *   platform code when there was one, and the message the platform gave.
 */
export function classifyRefusal(error) {
  const data = error?.response?.data
  const code = Number(error?.code ?? data?.code)
  const parts = [
    error?.message,
    error?.msg,
    data?.msg,
    // The SDK sometimes carries the whole envelope inside the message text, which is the only
    // place the platform's own wording appears when it threw before a body was parsed.
    typeof error === 'string' ? error : '',
  ]
  // Deliberately not `String(error)`: an SDK error's `toString` omits the response body, which is
  // where the reason lives. The message is joined with the parts above instead.
  const message = parts.filter(part => typeof part === 'string').join(' ')
  const kind = (of) => ({ kind: of, code: Number.isFinite(code) ? code : undefined, message })

  if (code === 230020 || /frequency limit/i.test(message)) return kind('frequency')
  // The envelope first: its `msg` decides which of the three card-shaped reasons this is, and a
  // card-content failure must not be read as a size refusal for the word "exceed" inside it.
  if (code === 230099 || /failed to create card content/i.test(message)) {
    if (/table number over limit|table/i.test(message)) return kind('tables')
    if (/element exceeds the limit|number of card components|components exceeds/i.test(message)) return kind('elements')
    return kind('content')
  }
  if (code === 230025 || /size|too large|too long|too many bytes|length|exceed|payload/i.test(message)) return kind('size')
  return kind('other')
}

/**
 * The three refusals a card can answer by changing the card itself, and what each one gives up.
 *
 * `size` halves the text and drops the fold, `elements` drops the fold, `tables` flattens the
 * tables, and `content` — a card-content failure we cannot name — gives up all three. Everything
 * else is either worth a plain retry (`frequency`, and any transport failure that never reached
 * the platform) or not worth retrying at all (`other`: a missing scope, a recipient outside the
 * app's availability, a dissolved chat — sending the identical card again cannot fix those).
 * @param refusal - what {@link classifyRefusal} reported.
 * @returns whether an identical retry could help.
 */
export function refusalIsRetryable(refusal) {
  if (refusal.kind === 'frequency') return true
  // A platform code means the platform answered and refused: `230002` ("the bot is not in the
  // group"), `230013` (the recipient is outside the app's availability), `232009` (a dissolved
  // chat) — the identical card cannot start working, so retrying it only delays the honest report.
  // No code at all means the request never got an answer (a dropped socket, an expired deadline),
  // and there the same card is exactly what should go out again.
  return refusal.kind === 'other' && refusal.code === undefined
}

/**
 * Count and, past the budget, flatten the Markdown tables in one string.
 *
 * The platform counts tables **across the whole card** and refuses it at six (measured
 * 2026-09-26: five arrived, six were refused, `230099 / card table number over limit`). The
 * documentation's "at most four per richtext component" is not what the service enforces — five
 * tables inside one element arrived and rendered in full — so one counter has to be threaded
 * through every element of the card, body and fold alike.
 *
 * Past the budget a table is not dropped, it is **written as text**: the separator row goes and
 * every row becomes one line of cells joined by ` · `. A reader loses the grid, not the numbers.
 *
 * @param value - the markdown a card element would carry.
 * @param state - the card-wide counter: `used` so far, `budget` for the whole card. Mutated.
 * @returns the content to carry, and how many tables were flattened while producing it.
 */
export function flattenExcessTables(value, state) {
  const text = String(value ?? '')
  const lines = text.split('\n')
  const kept = []
  /** One note per element, so a card of ten flattened tables is not a card of ten notes. */
  let noted = false
  const flattened = () => {
    state.flattened = (state.flattened ?? 0) + 1
    if (noted) return
    noted = true
    kept.push('（表格已转为文本）')
  }
  for (let at = 0; at < lines.length; at += 1) {
    const separator = lines[at + 1]
    // A table is a row of cells followed by the `|---|` rule that makes it one. Requiring a pipe
    // in the rule is what keeps a bare `---` horizontal rule from being read as a table.
    if (!(typeof separator === 'string' && lines[at].includes('|') && isTableRule(separator))) {
      kept.push(lines[at])
      continue
    }
    let end = at + 2
    while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('|')) end += 1
    const rows = [lines[at], ...lines.slice(at + 2, end)]
    state.used += 1
    if (state.used <= state.budget) kept.push(...lines.slice(at, end))
    else {
      flattened()
      for (const row of rows) kept.push(cellsOf(row).join(' · '))
    }
    at = end - 1
  }
  return { content: kept.join('\n'), flattened: state.flattened ?? 0 }
}

/**
 * Whether one line is a Markdown table's separator row.
 * @param line - the line to test.
 * @returns whether it is a rule made of dashes (and colons) with at least one pipe.
 */
function isTableRule(line) {
  return line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line)
}

/**
 * One table row as its cells.
 * @param line - the row.
 * @returns the trimmed cells, outer pipes removed and inner empties kept.
 */
function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

/**
 * A view with every table in it written as text.
 *
 * This is the reactive half of the table budget: {@link flattenExcessTables} keeps a card inside
 * the budget before it is sent, and this is what a card is changed to when the platform refuses it
 * anyway. It takes the view rather than a rendered card because that is the shape every producer
 * of a card holds, and because re-rendering is the renderer's job.
 * @param view - the channel-neutral view about to be delivered.
 * @returns a new view with no tables left, and how many were flattened.
 */
export function flattenViewTables(view) {
  const state = { used: 0, budget: 0 }
  const flatten = (text) => flattenExcessTables(text, state).content
  const flattened = view?.details === undefined
    ? view
    : { ...view, details: { ...view.details, blocks: view.details.blocks.map(flatten) } }
  return {
    view: { ...flattened, body: (view?.body ?? []).map(flatten) },
    flattened: state.flattened ?? 0,
  }
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

