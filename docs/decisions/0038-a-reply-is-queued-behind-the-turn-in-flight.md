# 0038 — A reply is queued behind the turn in flight

**Status:** accepted. Supersedes [0023](0023-a-reply-into-a-running-session-steers.md).

## Context

A reply typed on the phone was handed to a session that was already working through `agent.steer()`,
which places the reader's words **inside** the turn in flight and holds that turn open until they
have been consumed (`dsh-agent-loop/lib/index.js:800-814`, `:983-990`). [0023](0023-a-reply-into-a-running-session-steers.md)
chose that door on evidence: on the real machine a follow-up queued against a running session was
observed never to open its turn — the notice was consumed, the card moved, and no turn came of it —
and `steer` was the one door that demonstrably worked (`internal/boundaries.md`).

The mechanism behind that observation was never established, and the cost of the workaround turned
out to be paid by whoever was watching the session:

- **The turn in flight is commandeered.** The reader's message becomes part of work they never saw,
  which is what "the session I was watching got interrupted" describes.
- **Against a goal round it is worse than rude.** A goal continues itself: `dsh-goal-round-driver`
  opens the next round the moment the agent goes idle, with a `<goal_round>` prompt whose source is
  `{ kind: 'goal' }` (`dsh-goal-round-driver/lib/index.js:123-154`). A steered message lands in
  `next-step`, while that driver's competing-input rule reads `next-turn`
  (`dsh-goal-round-driver/lib/index.js:237-244`) — so the round in flight is hijacked **and** the goal
  carries on afterwards, and the instruction never becomes a turn of its own.
- **The harness's own client does not do this.** The gateway steers only when the caller asks for it
  by name (`dsh-api-session-controller/lib/index.js:882-883`); a person's plain prompt is queued.

## Decision

**A reply typed while the session is working is queued as a turn of its own, the reader is told it is
waiting, and the queue is watched rather than trusted.**

1. **`followup`, not `steer`.** It queues into `next-turn`, which the loop drains when the current
   turn ends (`dsh-agent-loop/lib/index.js:1020-1024`), and the goal driver counts it as competing
   input — so the person is answered first and the goal resumes after them instead of being derailed.
2. **The wait is said out loud, and it has a name when there is one.** The toast says the instruction
   is queued, and when a goal round is what is running it names the round and the cap — the same
   numbers the card is already showing. A reader who is told their reply is waiting does not read the
   session as stuck.
3. **Queueing is not proof, so every queued instruction is watched.** The message's own
   `user/message` event is the proof of admission — the same field the host's goal driver reads to
   answer the same question (`dsh-goal-round-driver/lib/index.js:258-259`) — and a session that
   reaches **idle** with the instruction still unaccounted for has drained everything it was going to
   run, so nothing will claim it.
4. **That case falls back to `steer`, and the deployment log carries it.** On an idle driver `steer`
   starts a turn, which is exactly the turn the queue promised, so the reader gets the delivery they
   asked for. It is logged rather than drawn on the card: the card was already rewritten to say the
   instruction was queued, and the platform notifies nothing for an edit — a card that changed under
   the reader minutes later, with no notification, is worse than a deployment log line.
5. **The watch ends with the plugin.** Unloading clears it: an instruction is no delivery promise of
   a plugin that is no longer loaded.

## Consequences

- **The phenomenon 0023 worked around is now visible and self-healing.** `internal/boundaries.md`
  keeps the row — the mechanism is still unproven — but its consequence changes: a dropped queue is
  detected, repaired, and reported, instead of being the reason every running reply was steered.
- **`#50`'s premise is re-read against 0.1.7.** The observation was made on 0.1.6; on the harness
  this was written against, a queued `next-turn` is drained by the loop that is already running
  (`dsh-agent-loop/lib/index.js:1020-1024`). The case that encoded the old behaviour
  (`tests/result-run.test.mjs`) is rewritten to the queue, and two cases are added: one where the
  session admits the instruction and is therefore left alone, and one where it never does and the
  fallback runs with its log line.
- **`/help` says what a reply does while a session works**, in both languages, because the old
  sentence promised the steering this record removes.
- **No explicit steering action is offered yet.** A person who *wants* to interrupt the work in front
  of them — rather than wait for it — has no control for that on the phone. That is a deliberate
  omission: the door exists in the harness, but a control that hijacks a turn needs its own card copy
  and its own decision, and inventing it here would be deciding for the reader which of the two they
  meant.
