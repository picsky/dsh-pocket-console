# 0012 — The desktop composer steps without the phone

**Status:** accepted.

## Context

The phone card steps one question at a time ([0011](0011-one-question-per-card.md)), and the
desktop composer does too. They do not step *together*: answering question 1 on the phone leaves
the composer where it was, and only when every question has been answered does the composer
close. The obvious wish is that the composer advance with the phone, one question per answer.

This record exists because the answer is no, and the reason is not obvious from this repository:
it is a property of the Harness's own composer, which this plugin does not own.

## Decision

**The desktop composer's progress is not reachable from a plugin, and the phone does not try to
drive it.** The phone's answers reach the desktop in one step, when the request is decided.

The evidence, from the Harness's own types
(`@deepseek-ai/dsh-client-ui-user-questions`):

- The composer's pending interaction is a `PendingQuestion` whose entire public surface is
  `answer(answer: QuestionAnswer)` — documented as "Resolve the Host waterfall with the whole
  answer batch" — plus `delegate()`, `cancel()` and `abort()`. There is **no** per-question entry
  point: no `setAnswer`, no step, no index.
- Which question is on screen and what has been typed so far live in a separate
  `QuestionDraftProgress { index, drafts[] }` inside a store made by `createQuestionDraftStore()`.
  That store is created by the composer component, owned by the Slot registry, handed to the
  component as a prop, and is **not registered as a service** — its own doc comment says the
  factory is exported "so a plugin reload cannot reuse a module-global handle". It is deliberately
  out of reach.
- `answer()` resolving the *whole* batch is not an implementation detail to work around: an
  unanswered question has no answer to send, and inventing one would decide the request with
  something the reader never chose.

So the only supported way to end the composer is to answer the request, which is exactly what the
mirror does the moment the phone has answered every question. `QuestionAnswer` is defined as "one
structured answer batch covering every question of the request" — the batch is the unit.

## Consequences

- A reader answering on the phone sees the desktop composer wait, then close. That is the
  contract, not a bug to be papered over, and it is now documented rather than re-investigated.
- The reverse direction is unavailable for the same reason: the phone card cannot show how far
  the desktop composer has got, because a partially answered composer publishes nothing. The
  card's progress line counts *phone* answers only, and the desktop-free case is the one the
  card is for.
- Reaching the draft store would mean depending on another plugin's React internals through a
  handle its author explicitly kept private. It would break on any refactor of the composer, and
  it would break *silently* — the failure mode of driving another component's private state.
- If a future Harness version publishes per-question progress on the pending interaction, this
  record is what should be revisited: the mirror already identifies the composer by the request's
  whole question-id list, so it would have somewhere to put a per-question update.

## Alternatives

**Answer the batch with placeholders for the unanswered questions**, so the composer would close
early and the phone could carry on. Rejected outright: it decides a request with answers nobody
gave.

**Call `cancel()` on the composer** once the phone has started answering, so the reader does not
watch a composer that will only close later. Rejected: `cancel()` is documented as rejecting the
waterfall because the user closed the question, which settles the request as *unanswered* — it
would throw away the very answers being collected.

**Render the phone's progress in a UI surface of this plugin's own**, beside the composer.
Possible, and it does not advance the composer — it only reports. Rejected for now as a new
surface that solves a cosmetic complaint: the reader who is answering on the phone is not looking
at the page.
