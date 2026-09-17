# 0007 — Prepend the answerer, call `next()` first, and race the timer

**Status:** accepted.

## Context

Both seams this plugin serves are Cordis **waterfall** events. An answerer is a
listener that either returns an answer or calls `next()` to hand the request to the
answerers behind it. DSH's own Web GUI forwarding listener is one answerer on each
chain, and an unattended run stalls on exactly these two events.

That listener is the reason this plugin cannot simply register like any other
answerer. **While a browser is connected, it does not call `next()`.** It forwards
the request to the connected page and waits for the page to answer it. So an
answerer registered *behind* it never runs at all in the one deployment this plugin
exists for — the GUI is open, the person has walked away, and the request sits
forwarded to a page nobody is looking at.

Registering behind it and waiting is therefore not "slower", it is never. The
ordering has to change, and the plugin has to be the one that decides what happens
to the request it now owns.

## Decision

**Register with `prepend: true`, so this answerer runs before the GUI's, and call
`next()` first.**

The desktop chain keeps running exactly as it would have: `next()` returns the
desktop's own promise for the request, untouched, and the page still receives the
forwarded request and can still be answered there. Nothing about DSH's behaviour is
replaced or patched — this listener only decides *additionally* to offer the same
request to a phone.

**The two answers race.** Whichever settles first wins:

- the desktop promise → the outcome is returned as-is, and any card that went out
  is rewritten to say it was answered at the desk;
- a phone action → decoded into the same outcome the desktop would have produced.

Two properties make this safe rather than a second, competing answerer:

- **A delivery problem cannot change the answer.** If the channel is unavailable, or
  the card cannot be delivered, the escalation abandons the phone side and leaves
  the desktop branch racing alone — it never settles the request with an answer
  nobody gave (`escalation.js`).
- **Approval semantics are unchanged.** A grant from the phone is `allowed-once`,
  exactly what the desktop's own button produces, and the random id that carries it
  dies the moment the request settles.

## Consequences

- The desktop still answers first in practice: a card is only sent after
  `delaySeconds` with nothing answered, so the default deployment never reaches the
  phone while somebody is at the desk. `delaySeconds: 0` makes both sides live at
  once, which is the setting for "I am only ever at the phone".
- Because this listener now owns a request the GUI's listener is also still
  holding, a phone answer leaves the desktop composer waiting for a decision that
  already happened. The browser half closes it by replaying the same client call a
  click makes (record [0002](0002-desktop-mirror-runs-in-the-browser.md)). That
  obligation is the direct cost of prepending: owning the request means owning what
  the page is left showing.
- Ordering is load-order dependent in a way that is not visible from either file:
  reading this plugin's `ctx.on(..., { prepend: true })` tells you nothing unless
  you know what it is being prepended to. Hence this record.

## Alternatives

**Register a normal (appended) answerer and rely on `next()` being called.** Never
runs while a browser is connected, which is the deployment this plugin is for.

**Patch or replace the GUI's forwarding listener.** Would work, and is exactly what
this plugin refuses to do: it ships as a profile layer and registers on documented
events, so a DSH upgrade cannot break it and nothing in the harness is forked.

**Do not call `next()` at all, and take the request over.** Simpler to reason about
and wrong: it removes the desktop as an answerer, so the deployment loses the
desktop-first property that makes this plugin worth having over "forward everything
to my phone".
