# 0013 — A notice is remembered, so a restart is not an expiry

**Status:** accepted.

## Context

`README.md` makes a promise about result notices: they stop taking replies when the
session's latest word moves on — a newer result, or new input from any surface — and
**there is no time limit, so a notice you come back to tomorrow is still an offer.**

The mechanism did not keep it. The set of live notices was a `Map` in `results.js`, so a
notice's validity window was the lifetime of the process, not the lifetime of the result. Any
restart — routine while working on this plugin, and routine for anyone who upgrades it —
withdrew every outstanding notice at once. Worse, the card said `该结果已过期` / "That result
has expired", which was false: nothing expired it, the process forgot it. The reader was left
with a card that looked answerable, a message blaming time, and no way to tell the two apart.

The retirement rules themselves are sound. What they need is the session's log: "has a person
spoken since this notice went out" is answerable long after the fact, but only by asking the
session rather than by having watched it.

## Decision

**A live notice is kept in the durable storage hub, and a restart re-applies the rules instead
of ending them.**

- The plugin owns one domain, `pocket_console`, with one table, `notices`, keyed by the notice's
  rid, `layout: 'per-record'` so each notice is a document of its own and one bad record cannot
  cost the others. Under that layout a key becomes a path segment, which makes the rid's
  grammar load-bearing: it is `n` plus twenty hex characters, path-safe on every platform, and a
  test pins that rather than leaving it to look like a coincidence.
- A record holds `{ session, handle, seq, workspace, sentAt }`: the session to instruct, the message to
  rewrite, the session's last event seq when the card went out, and when it went out. `workspace` is
  optional: a rewrite after a restart uses it to keep naming the same project.
- It is written **after the card is delivered** — a card that never arrived has nothing to put
  back — and deleted durably wherever a notice stops being live: consumed, superseded, or
  retired. So single use survives a restart, which is the property that makes persisting a
  capability acceptable at all.
- At startup the records are read back and each is re-checked against the same rules: the
  session may have been deleted (retire), or a person may have spoken since `seq` (retire, with
  the copy the live path would have used). What cannot be determined is not assumed: with no way
  to ask, the notice stands, which is what the documented promise says it does.
- `RESTORE_LIMIT` caps how many come back; the oldest beyond it are retired rather than left as a
  growing pile of cards that all claim to be live.

**A dormant session is not a deleted session.** `ctx.agents.get()` returns only *live* agents,
and a restart leaves every session dormant until the Web client resumes the one it opens. So
"does this session still exist" is asked of the durable corpus (`sessionQuery.filterSessions`),
never of the live registry — asking the registry would retire every notice on every restart,
which is the bug this record exists to fix.

**A press may not retire a card before this side has finished looking.** The record is on disk,
but a restarted process has not read it yet — the medium can take seconds to answer, and in one
observed run it took half a minute. A press arriving in that window finds nothing, and "finds
nothing" is not "is gone": retiring the card then destroys an offer that was still valid, which is
the one outcome the durable record exists to prevent. So a press retires a card only once the
medium has been reached and the restore has finished, or once the deployment genuinely has no
medium to reach. Before that it reports and changes nothing, and the card is still there to use
when the process can serve it. That satisfies both complaints at once: a card for a request that
is really gone stops looking answerable, and a card whose notice is merely not loaded yet is never
thrown away.

**The store opens when it is first needed, not from a startup path.** This one cost a real
failure. The store first opened only while restoring, and `put`/`remove` did nothing while it was
closed; the storage facility is provided inside another plugin's own activation
(`domainCtx.provide('storageDomain', …)` inside its inject callback), so it can appear *after*
this plugin loads. A notice delivered in that window was dropped in silence — no record, and no
log line either, because "no service yet" and "nothing to write" look the same from inside. The
first manual test passed for the wrong reason: the card being replied to had been sent by a build
that predated the store entirely, so there was nothing to restore whatever the store did. Two
things are therefore part of the decision, not implementation detail: the store reaches the medium
on first use, and both restore triggers (installing the listener, and the service arriving) are
single-flight, because opening one domain twice is refused by the facility. Its state is *visible*
too — a missing service says so once, a refused medium warns — because silence is what turned a
defect into a filesystem dig.

**The plugin does not resume a session to deliver a reply.** A reply needs a live agent, and
while the session is dormant the press is refused with `会话已不在运行` / "That session is no
longer running" — true, and different from an expired result. Resuming would mean the phone
choosing the model and preset for a session, and starting work the desk never asked for. The
desk owns the session lifecycle; the phone instructs a session.

## Consequences

- **The rid is on disk, for the first time.** It is a capability: whoever holds it can send one
  instruction to one session. It is unguessable (`randomUUID`), single-use, and deleted from the
  medium the moment it is used or retired — but it is now a file under `DSH_HOME`, and that is
  the cost of the promise. The record carries no credential and no message text.
- A deployment without the storage hub keeps the previous behaviour: notices are not remembered,
  and the log says so rather than failing. A wiped medium is the same case, and so is a
  different machine.
- Both new imports (`@deepseek-ai/dsh-storage-domain`, `zod`) are optional peers, and they are
  imported *only after* the service is known to be present. A deployment that lacks them cannot
  fail to load this plugin.
- The stored set is naturally one record per session that received a notice and then went quiet.
  Restoring is capped, and every record is deleted as soon as its notice is answered or
  superseded, so the set tracks outstanding offers rather than history.
- A session that moved on while the process was down is now retired for the right reason. The
  card's explanation is finally the actual one.

## Alternatives

**Keep the registry in memory and only fix the wording.** The cheapest honest change: say "DSH
was restarted" instead of "expired". Rejected because the wording was never the promise — the
promise is that the card still works, and a better excuse for a broken promise is not the
feature.

**Persist through the credential record store**, which the plugin already uses for its recipient
binding and which takes owner-defined JSON payloads. Rejected: those records are credentials and
authorization grants, they are enumerated by configuration surfaces to show *what a user is
authorized for*, and a notice would appear in that list as though it were one. Convenience is not
a reason to put non-credential state in a credential store.

**Resume the session from the reply**, so the phone works with the desk closed. Rejected above,
and worth restating as a product boundary rather than an omission: it would make the phone the
thing that decides a session's model and preset.

**Store nothing and re-validate from the session log alone**, deriving live notices by scanning
recent sessions at startup. Rejected: a notice that was never delivered, or was delivered and
then answered, is indistinguishable from one that is still waiting, so the phone would offer
cards that do not exist and would re-offer cards already used.
