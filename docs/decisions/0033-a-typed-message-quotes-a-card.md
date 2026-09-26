# 0033 — A typed message is an instruction, and only when it quotes a card

**Status:** accepted.

## Context

The card's `input` has a platform ceiling of **1000 characters** — enough for a reply to a running
session, not enough for the first prompt of a new one — and typing in the chat beats filling in a form
on a phone. The chat is also the cheaper surface: a text message may weigh 150 KB against a card's 30,
and receiving one needs no scope this deployment does not already hold (`im:message.p2p_msg:readonly`),
so onboarding stays "scan one QR code".

What makes it possible is one field. The platform sends `parent_id` **only when a message replies to
another**, and it is that message's id — documented, and for a card an id this plugin already holds
because it sent the card. So "which conversation is this message about" is a lookup, not a guess. The
field's behaviour in a p2p chat is not separately documented, which is why the design is built to fail
safe: the anchor is verified against the tenant before this record is relied on, and a `parent_id` that
matches no card we know produces a hint rather than a routing decision.

The person who uses this plugin chose the rules below, and one of them is the load-bearing one: **a
message that quotes nothing is not acted on.** Guessing which session an unquoted message belongs to
would be worse than doing nothing, because the instruction would land in the wrong conversation. Doing
nothing is not the same as saying nothing.

## Decision

- **A quoted card is the target.** The text of a message whose `parent_id` is a card we know goes to
  that card's session, through the **same path a form reply takes** — claim the notice, hand the
  instruction over, put it back if the send did not land ([0021](0021-the-card-you-pressed-is-the-one-that-moves.md),
  [0023](0023-a-reply-into-a-running-session-steers.md)). No new semantics: typing in the chat and
  typing in the box mean the same thing.
- **An unquoted message is not routed**, and the reader is told once per
  {@link HINT_INTERVAL_MS} window per person. Commands are the exception, because their intent is in
  the word itself: `/help` asks about the channel and needs no card.
- **`/new <prompt>`** opens a new session in the workspace of the quoted card, inheriting it and never
  choosing it ([0016](0016-the-phone-can-start-the-next-task.md)). Without a quoted card there is no
  workspace to inherit, so it explains rather than guesses.
- **The card is the confirmation.** A quoted instruction that lands rewrites its card into the running
  card, which is what a form reply does; nothing extra is sent, because the promise is that a round
  costs one message and not two. Only a failure speaks.
- **Delivery is deduplicated on `chat_id + message_id`.** The platform's own page for
  `im.message.receive_v1` asks for exactly this and says not to rely on `event_id`; at-least-once
  delivery means a repeat is normal, and a repeat that carries an instruction must not hand it over
  twice.
- **The three-second budget is respected by construction.** The handler looks up, hands over, and
  returns; the reply is sent **after** the decision is returned, so a slow send cannot become a
  redelivered event. (The SDK does not acknowledge on the plugin's behalf.)
- **A card's prompt line says how to do it.** Replacing an input box with a convention means the
  convention has to be written on the card: the result card's hint names quoting, `/new` and `/help`.

## Consequences

- A long prompt reaches a **new** session from the phone, which the card's form could not do: the
  1000-character ceiling no longer decides what a person may ask for.
- The anchor survives a restart for result cards, because the notice store already keeps
  `message_id → session` durably and is rebuilt at startup. Activity and approval cards are remembered
  in memory only, so a quoted card that no longer exists gets the hint — never a wrong session.
- A failed instruction is reported in words rather than by a toast nobody sees; `/help` is available
  without quoting anything.
- The plugin now reads message text. It reads it from an event it already subscribed to, for the bound
  recipient only, in direct chats only — a group message is still ignored, which is what keeps a group
  member from becoming the operator.
- No new scope, so an installed deployment that upgrades gets this without re-authorising.

## Alternatives

**Route an unquoted message to the most recent card's session.** The zero-memory option, and rejected:
"the session I last saw" is not what the person meant, and the cost of being wrong is an instruction
executed in another project. The hint teaches the rule instead.

**A pinned "new session" card, whose replies always mean a new session.** Rejected by the person who
uses this: it adds a standing card for a low-frequency act, when a prefix does the same job. It also
would have been the first implementation of a pinned status board this plugin has never built.

**A reaction (👍) as the "received" acknowledgement.** Rejected for now: it needs a fourth scope, which
means every installed deployment re-authorises, and there is already a faster confirmation — the
quoted card turns into the running card on its own.

**`thread_id` as a second channel.** Rejected: the platform's topic features are described for groups,
a p2p chat has no topic concept, and a third-party report has `reply_in_thread` in a direct chat
quietly opening a new discussion surface. `parent_id` is the only anchor with documentation behind it.

**Read the quoted message's content.** Rejected as unnecessary: the event carries only ids, reading the
body would need `im:message:readonly`, and a card's id is worth more to us than its text — we already
know what we sent.

## What would reopen this

- Measurement showing that a p2p reply does **not** set `parent_id` to the quoted message's id. The
  failure mode is already safe (a hint, never a misroute), but the anchor would have to be replaced.
- A second channel of intent that the platform makes reliable in direct chats — then the "unquoted is
  not acted on" rule could be relaxed without guessing.
- Evidence that hints are being reached in normal use, which would mean the card's prompt line is not
  teaching the rule well enough.
