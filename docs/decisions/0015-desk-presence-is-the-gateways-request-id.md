# 0015 — Desk presence is read from the gateway's request id

**Status:** accepted.

## Context

The desktop head start is a bet that somebody is sitting at the desk. Phone priority calls that bet
off: once a person answers from a card, the wait becomes zero, because making them wait out a head
start for an empty chair delays the only surface that can answer
([0007](0007-prepend-and-race-the-desktop.md)).

That leaves the way back. Something has to be able to say "there is a person at the desk again",
and the plugin cannot see a person. It can only see the session log.

The rule the maintainer set is **a person is at the desk when they do desk work**: typing into the
composer, answering an approval, answering a question. A page that is merely open is not desk work —
and treating it as such would be worse than the problem, because a browser tab left open from
yesterday would keep dragging phone priority back to the desk while the person is out.

## Decision

**A human message whose `source` carries a non-empty `rpcId` means somebody typed at the desktop,
and it moves the side back to the desk.** The browser reaches a session through the gateway's
session controller, which stamps that id; nothing else does.

The evidence — every producer of a `{ kind: 'user' }` message in the current Harness, checked one
by one rather than sampled:

| Source | `rpcId` |
|---|---|
| The browser, through `dsh-api-session-controller`'s `prompt()` | **yes** — `{ kind: 'user', rpcId: request.requestId, … }` |
| This plugin's own instruction from a phone card (`results.js`) | no |
| `dsh-headless` | no |
| `dsh-sdk-jsonrpc-server` | no |
| `dsh-acp` | no |
| `/commands`, plan mode, goal | no |
| Plugin-injected context | no — and its `kind` is `plugin`, not `user` |

The id is the whole difference, and it is **load-bearing**. Widening the rule to "any human message
means somebody is at the desk" would count this plugin's own phone-side instruction, so tapping a
card on the phone would hand the head start straight back to the desk and undo the thing that put
the phone in charge. That is a worse fault than the one this rule fixes.

Answering a question at the desk needs nothing extra: the desktop branch of the answerer's race is
the same code for approvals and questions, and it already moves the side.

The move back is wired **inside the priority state** rather than at its callers, because more than
one path puts a person at the desk and none of them should have to know that a return also has to
re-time whatever skipped the head start.

## Consequences

- Typing into the desktop composer restores the head start, which is the case that was missing: a
  person who came back and carried on working from the keyboard was leaving the deployment behaving
  as if they were still holding the phone.
- **`rpcId` is not a declared field.** It appears in no `.d.ts` in the Harness — it exists only in
  the object `prompt()` actually writes. Reading it is therefore defensive
  (`typeof source.rpcId === 'string' && source.rpcId !== ''`), and the failure mode if upstream
  renames or stops writing it is **silent**: the head start simply stops coming back, with nothing
  in the log to say why.
- Because of that, the rule rests on a reading of the gateway's code rather than on an observed
  message: one composed session, typing once into the desktop composer with the deployment on phone
  priority, is what would turn it into an observation. It is the one part of this behaviour that
  this repository's tests cannot settle — they assert the rule against the shape they are given,
  which is the shape the gateway's source says it writes.
- The rule is exercised in both directions, and both were checked by mutation: removing the signal
  fails the positive case, and widening the rule to any human message fails the negative one.
- A page that is open but idle still does not count, by decision rather than by omission: the
  browser's one-second state poll is not desk work.

## Alternatives

**Treat the browser's poll as presence.** The page already polls the state route once a second, so
"a browser is connected" is free to observe. Rejected: a page left open is this plugin's whole
premise, and an idle tab would hold the deployment at desk priority indefinitely while the person
is away — the exact failure phone priority exists to prevent.

**Have the browser half report submissions.** `client.js` is this project's own code and could say
"the reader just sent something" through the route it already posts mirror reports to. It would be
exact and would not depend on an undeclared Harness field, which is a real advantage. Not taken now
because the client half's reach is `uiSession.pendingInteractions`, which is the approval and
question panel — not the composer — so the prompt-submission hook is not known to exist. This is
the first thing to revisit if the field above ever breaks.

**Read the desktop composer's state.** Unavailable for the same reason as in
[0012](0012-the-desktop-composer-steps-without-the-phone.md): the composer's store is created by the
component and is deliberately not registered as a service.

## What would reopen this

- `rpcId` disappearing from the gateway's source object, or being written by some other producer of
  human messages — both would need a new rule, not an edit to this one.
- A supported way for a plugin to observe composer submissions, which would replace inference with a
  report.
