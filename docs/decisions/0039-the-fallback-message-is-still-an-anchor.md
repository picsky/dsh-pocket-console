# 0039 — The message a result falls back to is still an anchor

**Status:** accepted.

## Context

A result that no card can carry goes out as a plain-text message
([0031](0031-a-limit-changes-the-card-never-whether-it-arrives.md)). That message says so in its own
headline, and the headline told the reader to answer from the desk — because it has no form. A card's
reply box and its next-task offer are elements, and a text message has none.

The reader's report is what that costs: *"the content arrived as plain text and I could not reply to
it — the conversation just stopped."* The trade 0031 made was "arriving is worth more than being
interactive", and it is right about the answer. It was wrong about the conversation. The result card is
not only an answer; it is the reader's way back into the session, and **every other path this plugin has
for continuing a conversation is anchored on a message id**:

- a press carries `open_message_id`;
- a typed instruction carries the quoted message's id as `parent_id`
  ([0033](0033-a-typed-message-quotes-a-card.md), [0036](0036-a-quoted-card-is-answered-by-the-message.md));
- `workspaces` keeps message → workspace and session, and the durable notice store keeps message →
  session, which is what makes a quote work after a restart.

The fallback threw its own message id away: `sendText` discarded the response to the send that created
it. So the one message that did reach the reader was the one message with nothing behind it.

## Decision

Three changes, along the one anchor.

- **The fallback message names itself.** `sendText(text)` resolves to the message the platform created,
  and to `undefined` when it named none. It deliberately does not throw on an unnamed message the way
  `deliver()` does: arriving is this path's whole reason to exist, so a message the platform did not
  name is still a message the reader has. `undefined` says no anchor was kept, not that nothing was sent.
- **The anchor is recorded where the same lookup already reads.** `results` records the handle in
  `workspaces` — with the session, and with the workspace so `/new` knows what a session started from
  this message would inherit — the moment the text is accepted. One registry and one lookup: `inbound`
  asks `workspaces.sessionOf(handle)` for a quoted card anyway, so a quoted fallback message resolves
  through the mechanism that already exists rather than a second one built beside it.
- **A reply with no card behind it is confirmed in words.** `replyByHandle` answers `cardless: true`
  when the instruction went to a session found through the registry rather than through a notice, and
  the message path answers with one short confirmation. Nothing else will say it: every other
  successful reply is confirmed by the quoted card turning into the running card
  ([0021](0021-the-card-you-pressed-is-the-one-that-moves.md)), and this message has no card to do
  that. A reader who hears nothing cannot tell that from an instruction that went nowhere — which is
  the same failure this record exists to remove.

## Consequences

- Quoting the fallback message reaches the session, and so does `/new` quoted from it, because both read
  the same lookup. The headline no longer sends the reader to the desk.
- The anchor is **not durable**, and deliberately not a notice. A notice is stored, restored and
  rewritten, and every rewrite ends at `im.message.patch` — a card edit, aimed at a message that is not
  a card. So a restart loses this way back until the next result, which arrives as a card whenever one
  can be carried. The desk always still has the session.
- One instruction that reaches the session through the fallback costs one reply message, which this
  plugin otherwise refuses to spend ("a round costs one message and not two"). It is bought back only
  where the card's own confirmation — the rewrite — does not exist.
- A hint or an error reply is unchanged: those are the plugin talking, not a conversation's outcome, and
  nothing may be aimed at a session by quoting them.

## Alternatives

**Record a durable notice for the fallback message too.** Rejected: that puts a text message's handle in
the notice store, where `restore` would bring it back live and the next supersede or reply would try to
`patch` it as a card. A path that fails loudly after every restart is worse than an anchor that lasts
until the next result.

**Give the fallback a card after all, at any cost.** Rejected: that is the one thing already measured to
be impossible. The platform refused every card shape this result could take, which is why the message
exists.

**Leave the reader to continue from the desk.** Rejected: it is the report, and it inverts the plugin's
premise. The phone is where the next decision was always going to be made.

## What would reopen this

- A platform surface where a text message cannot be quoted, which would make this anchor a promise the
  channel cannot keep.
- Evidence that the fallback is reached often enough that its missing features — the reply box, the
  next-task form, the run fold — are worth building outside a card, rather than anchoring a message
  that cannot hold them.
