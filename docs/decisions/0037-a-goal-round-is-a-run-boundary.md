# 0037 — A goal's round is a run boundary that says what it is

**Status:** accepted.

## Context

A session with an active goal keeps working long after the person stopped talking to it, and nothing
about that reached the phone. `dsh-goal-round-driver` opens each next round the moment the agent goes
idle: a `<goal_round>` prompt delivered with `agent.followup()` and a source of
`{ kind: 'goal', goalId, revision, round }` (`dsh-goal-round-driver/lib/index.js:123-154`). The round
is a turn like any other in the same session, and the round it opens is the work a reader is waiting
on.

Every card in this plugin was drawn at a person's sentence, and that is the whole of the failure:

- `results.js:1062` set its eligible flag only for a `user/message` whose source is `{ kind: 'user' }`,
  and the report refuses to run without it — so a round's `turn/end` produced no card at all in a
  session this process never saw a person speak in, which is the ordinary state of every deployment
  that restarted while a goal was armed.
- `activity.js:893` dropped every event on a settled record except a `user/message`, and `:953` then
  turned away any `user/message` that was not a person's — so a round could not move an existing card
  through either gate.
- The plugin never read `ctx.goals` at all: `grep -n goal` found two unrelated comments.

What a reader gets from that is the report this record comes from: a card that sits on the finished
face of the round before, with no state change and no description, so a session that is still working
and one that has stopped look the same. The same silence covered the three transitions that end a goal
— the round cap (`dsh-goal-round-driver/lib/index.js:125-131`), a pause after an interrupted round
(`:213-236`), and completion from inside a round — which are exactly the states after which nothing
else happens on its own, and therefore the ones a reader most needs.

## Decision

**A goal-sourced `user/message` is a run boundary that says what it is, and the goal's own state is
what the boundary says.**

1. The state is read from `ctx.goals.get(agent)` (`dsh-goal/lib/index.js:611`) and is never parsed out
   of the round prompt. The prompt carries `Objective:` and `Round: N/M` as well; reading those back
   would be a second implementation of the host's own vocabulary, drifting the first time either side
   rewords it. The host's events (`goal/changed`, `goal/activation-changed`) say when to read it again,
   and `get`'s live-agent fence (`:767`) makes every read defensive rather than assumed.
2. A round is **not** a person's words. It takes the run boundary — the card says
   `目标进行中 · 第 N/M 轮（自动继续）` with one clipped line of the objective — and takes nothing of the
   anchor: no `human` entry in the fold, no desk-presence signal, and no retiring of the notice the
   reader may still be answering. A machine continuing its own work is not somebody speaking.
3. A card reporting a round leads with where the goal stands and offers **no next task**: an offer to
   start something else is what "this is finished" reads like, and the goal's own machinery is what
   decides what comes next.
4. The three transitions are drawn on the card that is already on the phone, in place and with no
   message of their own — a bot cannot send one without notifying, which is why the activity card is
   edited rather than re-sent. They append nothing to the session log, so the goal domain's event is the
   only thing that can carry them.
5. An active goal the host has **disarmed** is not drawn as one that continues. It is still the
   session's goal and nothing will continue it until a person resumes it, which the host's own goal bar
   draws as its own state (`dsh-client-ui-goal/lib/client.js:167-170`); a card that said "自动继续" there
   would promise work that is not going to happen.
6. **The goal panel is optional.** `goals` is not part of the harness core, so the reader is inert until
   a deployment composes it (`ctx.inject(['goals'], …)`), and a deployment without it keeps every card
   exactly as it was — which the suite pins as a case of its own (`tests/goal-round.test.mjs`).

## Consequences

- `docs/troubleshooting.md` answers the report this record comes from: a card that still reads 已结束
  while the session works is a deployment whose goal panel is not composed, and the state route says
  which.
- The state route carries the goal — phase, round, the cap, and one clipped line of the objective, no
  secrets — read live for every live agent. That is what makes a page that was just opened, or a
  deployment that was just restarted whose remembered map is empty, show the goal without waiting for
  the next event.
- The reader keeps one bounded map of session → state, with the least-recently-used discipline the
  workspace registry, the activity records and the session names already use. The objective is clipped
  on the way in, so the map's footprint is bounded by the same number a card's is — the discipline
  `note()` already uses for the entries of a run.
- A **stand-in** was wrong in the same change, which is the class of divergence decision 0032 exists
  for: the harness's agent carried no `id`, while the goal service resolves an agent by it
  (`dsh-goal/lib/index.js:767`). The fake now carries both the id and the session id, the way the
  registry it stands in for always has.
- The evidence includes the negative: each new case was run against the previous code and shown to
  fail — the cards do not move at all without this — and the case that runs the same sequence on a
  deployment with no goal panel fails there only on the new route field, with every card assertion
  passing.
