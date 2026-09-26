# 0036 — A quoted card that is waiting for an answer is answered by the message

**Status:** accepted.

## Context

[0033](0033-a-typed-message-quotes-a-card.md) made a typed message in the chat an instruction, with the
card it quotes as the target. But it only reached the cards that belong to a **conversation**: a result
card and the running card both answer `workspaces.sessionOf(handle)` / `results.sessionOfMessage(handle)`
with the session they are about. An approval card and a question card answer neither — the escalation
machine records the delivered message against the card's **workspace** only, because a request is not a
turn in a session and routing an instruction to its session is not what an answer to it means — so
quoting one of them landed in the hint that says "I cannot tell which session this belongs to".

Those are the two cards most worth typing at. A question can ask for anything, including a whole
paragraph, and the box on the card is capped at **1000 characters** by the platform — which is the
constraint the typed-message channel exists to lift, and which the card now states out loud
([#107](https://github.com/picsky/dsh-pocket-console/issues/107)). An approval is a decision about what a
tool may do next, and a person already holding the phone and typing is not helped by being told to go and
find the button.

What a **press** carries is a payload: the request's opaque id, which is the escalation registry's own
key. What a **typed message** carries is the message it quotes, and nothing else. So the two directions
do not meet unless something keeps the other one: which request is waiting in which message.

## Decision

- **The escalation machine keeps `message → request`, beside the registry it already owns.** Written when
  a card lands, dropped in `release()` — the one function that knows everything a record holds — so a
  text answer can reach a request only while that request is still waiting.
- **The quoted card decides what the message means, and this is read before anything else.** A card
  waiting for an answer makes the text that answer. It is checked **ahead of the commands**, because a
  question can ask for anything: a question about what a branch should be called has the answer
  `/new-parser`, and `\b` stands between `w` and `-`, so the command would swallow an answer that was
  never a command. `/help` is still read first, because it asks about the channel rather than about the
  card.
- **The text becomes the payload the card itself would have sent, and then goes through the same
  decoder a press goes through.**
  - An approval: `{ v: 'allowed-once' }` or `{ v: 'rejected' }`.
  - A question: `{ v: '<label>' }` when the text names one of the current question's options, and
    otherwise the submit the card offers beside its choices, carrying the text as the typed answer.
- **An approval answers to exactly two words**, `允许`/`allow` and `拒绝`/`reject`, trimmed and matched
  case-insensitively — and to nothing else. Both languages always work, whichever language the card is
  in. A word that is not one of them **settles nothing at all**: not a rejection by default, not a
  prefix, not a near miss. The refusal names the two words that work.
- **The full-access switch is not reachable as a word, and must never become reachable.** It changes a
  session's policy rather than answering the request in front of the reader, and the card makes it pass
  the platform's own confirmation first. A word typed into a chat must not do what a deliberate press
  cannot, and the outcomes a typed answer can produce are exactly the two values in
  `approvalOutcomeFor`'s table.
- **Success is silent; failure speaks.** The card rewriting itself into its decided state is the
  confirmation, exactly as it is for a press ([0021](0021-the-card-you-pressed-is-the-one-that-moves.md));
  only a refusal — an unusable word, an empty quote, a request that is no longer open — costs a message.
- **Nothing about this path is durable.** The index lives in memory with the registry it mirrors, so a
  restart ends it: quoting an old card afterwards gets a hint saying the request is gone. That is the
  existing trade rather than a new one — after a restart the desktop branch is what remains authoritative
  — and it is the safe direction to fail in.

## Consequences

- An approval can be granted from the chat through exactly the code path a button uses: the race with
  the desk, the mirror to the browser half, the in-place rewrite of the card, the audit line. Nothing
  downstream can tell a word from a press, which is the point — an approval record has **no field for
  who answered it**, so a second answer path would be a second thing to keep in step and a second way
  for the record to be wrong.
- A question can be answered with a long answer — up to a text message's 150 KB rather than the box's
  1000 characters — without leaving the chat.
- A typo decides nothing. The reader is told which two words work, which is how the rule is learned
  without reading `/help`.
- The option-label match is deliberately shallow: trimmed and case-insensitive, no fuzzy matching. A
  multi-select question cannot be given several selections in one line of text, and rather than guess at
  separators the text becomes one selection when it names one option and the typed answer otherwise.
- `requestAt()` is asked on every incoming message, so the cost of the feature on the common path (a
  message quoting a result card) is one map lookup that misses.

## Alternatives

**Route a quoted approval card like a session card and let the escalation notice the text.** Rejected:
these cards carry no session, so the instruction would have nowhere to go — or, if a session were
invented for them, into a conversation that never asked for it.

**Persist `message → request` so a restart can still answer.** Rejected: after a restart the request may
already have been answered at the desk, and a durable index would let a word typed days later grant a
tool call for a request nobody is holding. "That request is gone" is the truthful answer.

**Accept a wider set of words (`ok`, `yes`, `好`, `同意`).** Rejected on the asymmetry: refusing a word
somebody meant costs one more message, while accepting one they did not costs a tool call nobody
authorized.

**Treat an unrecognized word on an approval card as a rejection.** Rejected: a typo would then decide
*against* the person, and the request would be closed for both sides by a mistake. Doing nothing leaves
it open for whichever side can still answer.

**Let a word reach the full-access switch too.** Rejected: it switches a session's policy rather than
answering the request, the card makes a press pass the platform's own confirmation, and the switch is
exactly the class of act that must stay deliberate.

**Parse several selections out of one line for a multi-select question.** Rejected: the separator is
unguessable (a label can contain a comma), and a wrong guess records an answer nobody gave. One exact
label is one selection; anything else is the typed answer the card also offers.

**Send the outcome back into the chat as a message.** Rejected: the card rewriting itself *is* the
outcome, and a round that costs two messages is the thing this plugin does not do.

## What would reopen this

- The anchor turning out not to hold in a p2p chat — `parent_id` not naming the quoted card. Then the
  typed path has no target at all, this included.
- A decision arriving from the wrong side, or a mirror/rewrite that behaves differently for a word than
  for a press: that would mean the two paths are not one path after all, and the remedy is to remove the
  divergence rather than to document it.
- A word that a person reasonably means being refused often enough to be annoying. The answer would be
  a **stated** longer list on the card, not a fuzzier match.
