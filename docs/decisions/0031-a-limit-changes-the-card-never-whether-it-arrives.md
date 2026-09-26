# 0031 — A platform limit may change how a card looks, never whether it arrives

**Status:** accepted.

## Context

A deployment's answer ended with nine Markdown tables. The platform refused the whole card —
`230099 / ErrCode: 11310 / ErrMsg: card table number over limit` — and the reader got nothing: no
card, no error, no line in the deployment log naming a reason. Four attempts went out, identical,
five seconds apart; then the notice was deleted and a single `log.warn` was left behind
([issue #74](https://github.com/picsky/dsh-pocket-console/issues/74), fixed by
[#96](https://github.com/picsky/dsh-pocket-console/issues/96)).

Three separate defects had to line up for that to happen, and each one was verified against the
running tenant on 2026-09-26 (`internal/feishu-limits.md` §11):

1. **Nothing budgeted tables.** `renderCard()` turned every block into a `markdown` element, body and
   fold alike. Measured: five tables arrived, six were refused, and the nine-table answer arrived not
   at all. The platform counts tables **across the whole card**; the documented "at most four per
   richtext component" is not what it enforces — five inside a single element arrived and rendered in
   full.
2. **The judge did not recognize the refusal.** `looksLikeSizeRefusal()` carried
   `{230025, 230020, 230002, 10002}`, of which only `230025` is about size: `230020` is a frequency
   limit, `230002` is "the bot is not in the group", `10002` is "the bot is not in the chat". The code
   that actually refuses a card, `230099`, was not in the set, and the wording test did not match
   `card table number over limit`. So the one failure that needed a degradation got none.
3. **The failure was silent.** The delivery path ended in `log.warn` with no platform code, no
   `diagnostics()` line, and four identical retries of a card whose content could not change.

The position this record fixes: **a limit may change how a card looks; it may never change whether a
card arrives.** Showing less is acceptable. Arriving nowhere is an incident.

## Decision

Four changes, in the order a card meets them.

- **Budget before sending.** `CARD_TABLE_BUDGET = 4` against a measured ceiling of five, in the same
  spirit as the existing text and element budgets: set below the measured refusal rather than at it.
  `renderCard()` threads **one counter through the body and the fold**, because the platform counts
  the card. Past the budget a table is **written as text** — the separator row goes, each row becomes
  one line of cells joined by ` · ` — so a reader loses the grid, not the numbers. The degradation is
  reported through a callback of its own (`onDegrade`), separate from the body-budget one, so the log
  line can say which thing was given up.
- **A refusal is classified, not guessed.** `classifyRefusal()` reads the platform's code, its
  sub-code and its wording, and answers with a kind: `tables`, `elements`, `size`, `content`,
  `frequency`, or `other`. Each kind gets the degradation that can help it — tables flattened,
  elements' fold dropped, size halved, an unnamed card-content failure given all three — and only
  `frequency` and a failure that never reached the platform (no code at all) are retried unchanged.
  A permission or availability refusal fails fast instead of being sent four more times.
- **A final failure is said out loud.** The result path calls `diagnostics()` with the kind, the
  platform code and its message, alongside the existing `log.warn`.
- **The last resort is a message, not a card.** When every card-shaped attempt fails, the answer
  goes out as a **plain-text message**. A text message is subject to none of the card's gates — no
  elements, no tables, and 150 KB instead of 30 — so it arrives where a card cannot. It carries no
  reply box, which is a real loss; a reader who gets the answer without controls is strictly better
  off than one who gets nothing.

Cards that are not a conversation's outcome are deliberately left out of the text fallback: an
approval card cannot be answered as text, and its request stays at the desk, so nothing is lost by
not sending one; an activity card is a status line that the result card carries anyway, and turning a
missing status line into a text message would be the push this plugin says it does not do.

## Consequences

- **A nine-table answer now arrives.** Verified against the tenant after the change: the nine-table
  view renders to four tables plus seven flattened ones, and the platform answers `code=0`.
- `230002`, `10002` and `230020` are no longer read as size refusals. A card refused because the bot
  left the group or the recipient left the app's availability now fails once, quickly, with a
  diagnosable line, instead of being halved and retried four times.
- The activity and escalation paths classify their refusals the same way, so a table refusal on
  either is degraded rather than retried identically. Neither gains a text fallback, for the reasons
  above.
- The text fallback is a third bounded write, and `tests/send-bounds.test.mjs` now counts it: every
  write to the platform still goes through the one deadline.
- The reported table count in a card is now a budget rather than an accident, which is what makes
  `CARD_TABLE_BUDGET` worth putting beside the other two in `budget.js`.

## Alternatives

**Raise the budget to five, the measured ceiling.** Rejected: the platform refuses at six, and a
budget set *at* the ceiling has nothing left for the next platform change or for a fold the card
grows on its own. Every other budget in this repository sits below its measured threshold.

**Drop tables past the budget.** Rejected outright: the numbers are the answer. A reader who loses
the grid can still read the content; a reader whose table was deleted never had it.

**Recognize the refusal by wording alone.** Rejected: the same wording differs per surface and per
locale, and a false positive costs a degraded card for a reason that had nothing to do with the
card. The code is what the platform promises; the wording only tells the kinds apart inside
`230099`.

**Keep retrying an identical card.** Rejected: a refusal that names the content cannot be fixed by
sending the content again. It buys nothing and delays the honest report.

**Send the text fallback for every failure, including permission ones.** Rejected: a text message is
refused by the same missing scope or the same availability rule, so the second attempt would only
add a failure to the log — and, worse, would look like a second, independent thing went wrong.

## What would reopen this

- A measured card ceiling other than five, or a platform that starts counting tables per element.
- A second gate that turns out to refuse cards for a reason the four kinds cannot describe; the
  answer is another kind, not a wider regex.
- Evidence that the text fallback is being reached in normal operation, which would mean a card
  budget is set wrong rather than that the fallback is doing its job.
