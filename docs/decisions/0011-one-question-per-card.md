# 0011 — One question per card, and the card steps

**Status:** accepted.

## Context

A card is a flat document: the renderer emits `body` as text blocks first and then the
controls (`buttons`, `forms`) after them, because that is the only order a card has. A request
carrying several questions was rendered into one card, so every question's text came first and
then every question's buttons underneath — with a `submitOther` form per question, all carrying
the same placeholder. The reader saw a pile of options and two identical "type your answer"
boxes with nothing to say which question either belonged to. Nothing in the view said which
button answered which question either: the association lived only inside the opaque `payload`,
which the contract forbids a channel from reading.

[0010](0010-the-channel-names-its-own-controls.md) treated the visible symptom — the platform
refusing a card that repeats an element name — but a card that arrives with every question
jumbled together is still not a card anyone can answer.

## Decision

**A view is one message, and a request that carries several questions is asked one question per
card.** Answering a question rewrites that same card to the next one; answered questions stay on
it as a `✅` receipt with their controls gone, and a progress line carries the count. The title
names the position when there is more than one question (`提问 · 第 2/4 题`).

This is the rhythm the desktop composer already uses — one question on screen, then the next —
so both surfaces walk the same request the same way. It also settles the naming problem at the
root: a card holds at most one form, so the names can no longer collide, and the mapping
described in 0010 becomes a guarantee for the renderer rather than a load-bearing repair.

The channel contract does not change. `deliver(view)` was already "deliver one message" and
`update(handle, view)` already "replace an already-delivered message"; the fix is in what the
core composes, not in what a channel must implement. No view gained a field.

## Consequences

- The reader sees one question at a time and cannot answer out of order. That is a deliberate
  cost, not an oversight: it is what the desktop composer does, and a card has no way to keep
  several questions' controls distinct without splitting them.
- A card that steps cannot be answered by two people at once, and a question that was already
  answered cannot be revised from the phone. Neither was possible before.
- Long asks get *smaller* cards, not larger ones. Four questions with long option legends used
  to share one card's byte budget, so the size retry that halves the text could silently clip
  content the reader needed; each question now has the whole budget to itself.
- The mirror is untouched. It identifies a composer by the request's whole question-id list and
  hands the settled answer set over in one call (`mirror.js`, `client.js`), none of which
  depends on how many messages the phone needed. A partial phone answer still is not mirrored —
  the request is not decided until every question has an answer, and the desktop wins the race
  outright if it is answered there first.
- `submits` and the namespacing stay. They are no longer required by anything the core builds,
  but a channel's renderer must be correct for the views it is handed rather than only the ones
  in front of it today, and removing them would break cards already sitting in a chat.

## Alternatives

**Keep one card and group by question with dividers.** Rejected: it needs the contract to grow a
shape that says which controls belong to which question — the very thing this decision avoids —
and it still puts every question on one card, so answering rewrites all of them and long asks
compete for one byte budget.

**One card per question, all delivered up front (N messages).** Rejected on the reader's behalf:
a four-question ask becomes four-plus messages, arriving as notifications, and a partly delivered
ask leaves cards on the phone that can never be completed — a failure mode the stepping card
simply does not have. It is also the only variant that would need per-question handle tracking.

**Leave the card and number the buttons to match the legend.** Rejected: it repairs the options
and leaves the two identical typed-answer forms and the answered-question rewrite exactly as they
were.
