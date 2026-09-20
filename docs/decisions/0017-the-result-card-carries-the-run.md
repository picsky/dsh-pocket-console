# 0017 — The result card carries the run, and gives up its middle

**Status:** accepted.

## Context

The result card carried the model's **last** message. That is not enough to act on: a turn that
produces a plan and then a few confirmations ends on a confirmation, so the phone says "done" while
the thing being confirmed — the plan — is nowhere on it. The person is left deciding the next step
without the text that step depends on.

What they need is **the run**: everything from the last thing they said to the moment it stopped.
That is a different question from "what did this session do" — it has a beginning, and the beginning
is the last human message.

## Decision

**A result notice carries the run in a folded panel on the same card, and when it does not fit, the
two ends are kept and the middle is given up by name.**

Each part of that is a decision:

- **On the same card, in a fold, not as a second message.** The fold is opened by the client, so it
  costs the card face nothing, and a result is already one message somebody chose to receive. A
  second message per run would be a notification this plugin promised not to send. The activity card
  made the same trade for the same reason.
- **The two ends, not a prefix.** The two things a decision rests on are *what the run set out to do*
  and *where it stopped*. In a long run those are the first and last parts of it, so a prefix keeps
  the plan and loses the ending, and a suffix does the reverse. Neither alone answers "what happened".
- **The omission is named, with a byte count.** A reader who is not told cannot tell a short run from
  a truncated one, and the two call for different next moves.
- **No "show me the rest" control.** Feishu cards cannot link to each other, and cannot open a page
  without this plugin serving one — which would mean opening a port, against
  [0007](0007-prepend-and-race-the-desktop.md)'s premise and the README's "no inbound listener". The
  only control available would be to rewrite the card longer, which meets the same 30 KB cap. So a
  run too long for a phone to show is a run whose middle is gone, and the card says so.
- **A plan often is one message, so the first entry is taken whatever it costs.** Measured while
  building this: a 60-step plan is a single entry of about 1.9 KB while half the room left after the
  marker is about 1.1 KB, so a rule that took only what fit dropped the head **every time a run had a
  plan in it** — the one thing the feature exists to show. It is clipped to the room instead.

## Consequences

- A reader on the phone can see what a run set out to do and where it stopped, without the desk.
- **What is shown is bounded twice**: the record's own bound (8 KB, oldest entries dropped) and the
  card's budget for the panel (half of the card's text budget), and both losses are reported together
  in the one marker. A reader is told a number, not told "some".
- The card's request body has to stay inside the platform's 30 KB with the panel included, and the
  body is escaped twice on its way out — the same accounting as `budget.js`. A case asserts it rather
  than trusting the arithmetic.
- A session whose run was only ever streamed, never committed, still has a run to show: the live
  frames are the only copy of that text and the record folds them at the turn's end.
- **It does not make the phone a reader.** Browsing sessions, scrolling history and searching stay at
  the desk; this is one run, the one the card is about.

## Alternatives

**A second card carrying the run.** Rejected: it is one more notification per run, which is the thing
the result card was shaped to avoid. The fold gets the same text to the same reader for no message.

**One card per part of a long run.** Rejected for the same reason, more so.

**Keep only the head.** Rejected: it loses where the run stopped, and "it made a plan and then…" is
not a decision.

**Keep only the tail.** Rejected: it loses the plan, which is the case this was built for.

**Raise the budget instead of trimming.** Rejected as a substitute: the platform's 30 KB does not
move, so a bigger panel only moves where the truncation happens.

## What would reopen this

- A way for a card to link to another card or a page this plugin does not serve, which would make
  "read the rest" possible without a port.
- Evidence that runs are routinely short enough that the middle is never lost, which would make the
  head-and-tail split unnecessary — but not wrong.
