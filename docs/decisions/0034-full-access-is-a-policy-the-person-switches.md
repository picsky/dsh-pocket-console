# 0034 — Full access is a policy the person switches, not a grant this plugin makes

**Status:** accepted.

## Context

An approval card offered two answers, `允许一次` and `拒绝`, and a person who is asked the same question
by the same tool for the fifth time wants a third one: *stop asking*. Implementing that as a third
answer is impossible, and implementing it by answering every request with `allowed-once` is dishonest.

DSH's approval vocabulary is a closed set — `allowed-once | rejected | cancelled | unavailable` — and
`allowed-once` is the only grant. There is no `allow-always`, no remembered rule and no grant store, and
the service's own README says so. What does exist is a **policy** knob: `approval` is `ask` or `never`,
and `never` short-circuits *before* the approval waterfall, so a session on it is never asked again —
it does not reach this plugin at all, and anything that still asks is refused rather than granted.

On top of that sits the product-level switch: `ctx.permissionPresets` bundles a sandbox mode with an
approval policy, and its shipped table contains `danger-full-access` — no confinement, and `never`.
`set(session, name)` writes `permission/preset`, `sandbox/mode` and `approval/policy`: three durable
session events that are log-only, replayable, and never in the model transcript.

**Why the obvious implementation is refused.** Answering each request with `allowed-once` would write
`approval/decided { id, outcome }` — a payload with **no actor**. That line is byte-for-byte what a
person clicking Allow once in the desktop writes. A deployment would read its own log and see a human
decision that never happened. Switching a preset writes something else entirely: that a person chose a
policy. The outcome is equally automatic; only one of the two records is true.

## Decision

- **The third control is a policy switch.** `以后不再问（完全权限）` appears on an **approval** card — never
  on a question card, where there is no policy to switch — and only when the deployment actually offers
  a preset whose bundle is `danger-full-access` + `never`. The preset is matched **by its bundle, not by
  its name**, and the card uses the deployment's own label for it, so a host that renames or relabels
  its presets gets its own words on the phone.
- **It asks before it acts.** The control carries the platform's own `confirm` dialog. The desktop
  requires a risk acknowledgement before a visible switch to full access; a plugin calling the setter
  would step over it, so the step is moved to where the press is — the one moment the person still has
  the context to answer it.
- **It grants the request it was pressed on.** Someone pressing "do not ask again" plainly wants *this*
  one to go through, so the current request settles as `allowed-once` — the only grant the vocabulary
  has — and the card becomes the record of what was chosen.
- **A switch that did not happen settles nothing.** If the service refuses, or the preset disappeared
  between drawing the card and pressing it, the press claims the action only to explain: the card keeps
  its buttons, the request stays open, and the ordinary answers still work.
- **Scope is one session.** That is the API's own scope, and it is the right one: an authorisation is
  not a permanent surrender. "Every future session, too" is a deployment setting
  (`DSH_PERMISSION_MODE`, or the `defaultPreset` row in the desk's General settings) and is documented
  rather than offered on the phone, because a button that pretended to do it would be a lie.
- **No host service, no control.** On a host that composes no permission service the card keeps the two
  buttons it has always had. Nothing degrades into an error.
- **The words say what it means.** The confirmation and the settled text both say that this path goes
  **quiet** on the phone, that actions still needing approval are **refused** rather than granted, and
  where to change it back — because `never` reads like "approve everything" and is the opposite.

## Consequences

- One session can be put beyond asking, deliberately, with a durable record of who chose it.
- **The phone stops hearing from that session's approvals entirely** — not "they are auto-approved", but
  "there is no card". That is a signal given up, and it is written on the card that gives it up.
- `boundaries.md`'s line 「永不自动批准 — 插件从不替你决定」 is no longer accurate as written and now reads:
  the plugin never presses Allow for anyone; a person may choose a policy, and DSH records the choice.
- The card's own line still reports the session's current permission, so a session running without
  guardrails is visible wherever its cards are seen.

## Alternatives

**A third answer that grants everything.** Impossible: the outcome vocabulary is closed, and a rogue
value is normalized to `unavailable`, which denies.
**Answer every request with `allowed-once` while the mode is on.** Rejected as forgery of the audit
trail (above), and it also fails to stop the cards: the service still asks, still logs, and still
dispatches the waterfall.
**A settings-card entry instead of a card control.** Rejected by the person who uses this: the moment
the question is felt is the moment the card is on screen, and a settings page is somewhere else.
**A deployment-level switch on the phone.** Rejected: it needs a profile edit and a restart, which a
button cannot do, and claiming otherwise is worse than not offering it.
**A time-boxed switch that reverts itself.** Rejected: DSH's `set()` has no notion of expiry, so the
revert would be a lifecycle this plugin invented and would have to own, for a case no one has hit.
**Auto-approving on a rule table inside the plugin.** Rejected for the same reason as the second
alternative, and it would also mean re-implementing an allowlist that DSH deliberately does not have.

## What would reopen this

- A DSH release that offers a first-class "remember this decision" grant — then the card's third control
  should become that, because the audit would be honest by construction.
- Evidence that full access is being switched on routinely, which would suggest the *default* is wrong
  rather than that the switch is useful.
- A host that reports the preset's bundle differently, which would make the by-bundle match miss and the
  control disappear; the failure is visible (no third button) rather than unsafe.
