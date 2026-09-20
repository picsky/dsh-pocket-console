# 0016 — The phone can start the next task, in the workspace it is already looking at

**Status:** accepted.

## Context

Every other thing the phone does in this plugin decides something the desk started: an approval, a
question, the next instruction for a session that just stopped. That was the whole position — the
phone *advances* work, it does not initiate it, and the README said so ("you cannot keep working from
the phone").

A plan breaks that. A long run finishes its shard while the person is away from the desk, and the
next thing that has to happen is "start the next shard". Nobody is at the desk to start it, so a plan
that ends each shard by waiting is a plan that only progresses while somebody is sitting down.

## Decision

**When a result notice goes out and the phone holds the person, the phone is also offered a new task:
a new session, in the workspace of the session the card is about, prompted with whatever the person
types.** It is the narrowest form of starting work, and each narrowing is deliberate:

- **The workspace is inherited, never chosen.** It is read from the asking session at the moment of
  the press, and the press carries no directory. A card is a credential for one decision; letting it
  name a path would turn a lost phone into a way to run work anywhere on the machine.
- **The model is the deployment's**, because the new session names none. Inheriting the asking
  session's would mean reading and re-installing a model selection on a session that was just
  created, for no gain.
- **Only while the phone holds the person**, the same rule the activity card follows. What could come
  next is something the desk can already see, and a card sent while somebody is sitting there is the
  push this plugin says it does not do.
- **It is one message per result, carrying one form.** No browsing, no session list, no history, no
  workspace picker. Those are the desk's job and stay there.

Two properties are load-bearing, and both fail silently if they are wrong:

- **The first prompt goes through the agent, not the session controller.** The controller's
  `prompt()` stamps the caller's request id onto the message source, and that id is exactly what this
  plugin reads as "somebody typed at the desk"
  ([0015](0015-desk-presence-is-the-gateways-request-id.md)). A task started from the phone would
  then hand the head start back to the desk and undo phone priority — the opposite of what the person
  just signalled by using the phone. The plugin sends `agent.followup()` with a plain
  `{ kind: 'user' }` source instead, which is what the result card's reply already does.
- **The workspace comes from the session the card is about, not from the answer.** The card records
  its session beside its message, which is what the registry that already kept workspaces per card
  was extended to carry.

## Consequences

- **The blast radius of a lost phone is no longer "one answer".** It becomes "one answer, or one turn
  in the workspace of a session that is already open". That is genuinely larger, and the README and
  SECURITY.md now say so rather than keeping a sentence that no longer describes the plugin. What is
  still bounded: the workspace cannot be chosen, the model cannot be chosen, settings and credentials
  are untouched, and every tool the run calls is subject to the agent's own approval rules — which
  means an approval raised by that run still comes back to the phone as a card of its own.
- A phone-started session is a session like any other: it appears in the desk's session list, its
  result notice arrives the same way, and it can be answered from the desk.
- The new-task card retires itself once used, because a form left in place invites a second press
  that would start a second session for one decision.
- The card is only ever a *new session*. "Continue this session" already has a home — the result
  card's reply box — so this does not become a second way to do the same thing.

## Alternatives

**Let the phone pick any workspace.** The obvious generalisation, and the one the issue originally
described. Rejected: it changes what a lost phone is worth from "one answer" to "arbitrary code
execution in any directory", for a convenience the next shard of a plan does not need — the plan is
already anchored to one project.

**Continue the session that just finished instead of starting a new one.** Rejected as a *design*,
not as a feature: the result card's reply box already does it, and it does it better, because a
reply lands in the conversation that produced the result. This record exists for the case a reply
cannot serve — a fresh session for the next shard.

**Confirm the task on a second card before starting it.** Rejected: it buys one more click of
deliberation at the cost of a second message for every start, and the confirmation would carry no
information the form did not already show. The narrowing above is what bounds the damage; a
confirmation that can be tapped by whoever is holding the phone bounds nothing.

## What would reopen this

- A workspace picker on the phone, which would need this record to argue with rather than edit.
- Session management generally (lists, search, archiving): out of scope by decision, and this record
  is the line it would have to cross.
