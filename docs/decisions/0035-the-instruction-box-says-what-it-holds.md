# 0035 — The instruction box states the platform's limit, and holds more than one line

**Status:** accepted.

## Context

A card's `input` is the surface a person types an instruction into. The platform caps it at **1000
characters** — `max_length` accepts `[1,1000]` and nothing higher, and past the cap the field raises a
**client-side error** rather than truncating — while `input_type` also offers `multiline_text` and
`rows` defaults to five (`internal/feishu-limits.md` §3.1, [文档]).

Both boxes on our cards were left at the platform's defaults: a single-line `text` field, with
`max_length` unset, and no copy anywhere naming the limit. `internal/feishu-limits.md` §7 carried this
as its **only ❌ row**, and the limit had already been reached on a real device — it is what opened the
message-channel work ([#98](https://github.com/picsky/dsh-pocket-console/issues/98)).

Two costs, in the order a reader meets them:

1. **The box arrives as one visible line.** On a phone a whole first prompt — the entire content of the
   turn — is typed one line at a time and cannot be read back before it is sent.
2. **The limit is not on the card.** A reader who types past 1000 characters learns about it from an
   error, with the text they wrote already in the box and no statement anywhere of what the box holds.

The chat is now the surface for a long instruction ([#98](https://github.com/picsky/dsh-pocket-console/issues/98)),
which is a reason not to build more into the box — not a reason to leave it worse than the platform
allows.

## Decision

- **Both `input` elements are `multiline_text`, at `rows: 3`.** Three rather than the platform's
  default five because the result card carries **two** of these boxes ([0019](0019-the-next-task-rides-the-result-card.md)),
  and every reader pays for the height.
- **`max_length` is written down**, at the platform's own ceiling, rather than inherited from the
  platform's default. A number this code depends on is a number this code states.
- **The copy states it, in both languages**: `输入回答（最多 1000 字）` / `Type your answer (up to 1000
  characters)`, and the same for the multi-select note and the next-task box. The reader decides which
  surface to use when the card arrives, which is exactly when a placeholder is visible.
- **No `auto_resize`, no `max_rows`.** Both are documented as PC-only, so they would be card content
  that serves one of the two surfaces this card is read on — and every field added to a card is another
  way for the platform to refuse it (`230099`), which the reader experiences as no card at all.
- **No new setting, no submit-time validation, no card-structure change.** The client's own error is the
  validation; a setting would be a preference for a platform constant.

## Consequences

- A prompt can be read back before it is sent, which is the whole of the first cost above.
- The limit is knowable before typing rather than after, which is the second.
- **Every placeholder now spends characters against the platform's 100-character placeholder cap.** The
  sentence that names the limit is the one most likely to overflow it, and a refused placeholder takes
  the whole card with it — so a test holds each of the three under 100 characters.
- **The number now lives in two places** — the constant the field is sent with, and the copy. A test
  binds the copy to the constant, so an edit to one that misses the other fails the suite rather than
  shipping a card that states a limit it does not apply.
- **Acceptance of the two fields on a real card is documented, not yet measured on this tenant.** The
  failure is bounded rather than silent: a card refused for its content is degraded and, at the end of
  that path, delivered as plain text rather than not at all ([0031](0031-a-limit-changes-the-card-never-whether-it-arrives.md)).
  A plain-text answer is worse than a card, so this stays on the list of things to confirm by eye.
- **Three rows is a layout choice, not a measurement.** How tall a `multiline_text` box renders on a
  phone was not measured before choosing; it is one line of code if three turns out to be wrong.

## Alternatives

**Leave it single-line, since the chat now carries long text.** Rejected: the box is still where a
*short* instruction is typed, and a single line is worse for a short instruction too. "A better surface
exists" is not a reason to make the surface in front of the reader worse than the platform permits.

**Take the platform's default of five rows.** Rejected: the platform does not know that our result card
carries two of these boxes, and a tall card is paid for by every reader of every card.

**Send `auto_resize` and `max_rows` so the box grows as it is typed into.** Rejected: PC-only, which is
the surface this plugin is not built around, and two more fields in a document whose rejection is
silent.

**Leave `max_length` unset, since the platform's default is the same number.** Rejected: the cap would
then be a platform default that this code happens to agree with, and the copy would be held to nothing —
a test can only pin a number somebody wrote down.

**State the limit in the card body instead of the placeholder.** Rejected: a body line costs the result
card *and* every question card, including the ones nobody types into, while the placeholder costs
nothing on a card with no box. The reader who needs the limit needs it before they start typing.

**Fall back to a plain-text instruction path for long text instead of a box.** Not this change: that is
the chat channel ([#98](https://github.com/picsky/dsh-pocket-console/issues/98)), and it is additive —
the box stays as the short path.

## What would reopen this

- A measured tenant **refusing** a card that carries these fields: the answer is another way of stating
  the limit, and explicitly not a silent removal of it.
- The platform raising the cap — 1000 would then be a number we chose rather than one we were given, and
  the copy would have to say which.
- `multiline_text` changing what a submit carries. It is documented to carry `\n`; a mangled instruction
  arriving from a multi-line box would be that, and it would outweigh the read-back it buys.
- Evidence that three rows is wrong on a phone — too tall to scroll past, or too short to be worth the
  change.
