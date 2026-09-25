# 0028 — The settings transport is not an injected dependency

**Status:** accepted.

## Context

Two DSH releases disagree about how a browser plugin reaches its settings, and they
disagree by removal rather than by addition. Up to 0.1.6 the browser half of
`ui-settings` provides `settingsScope`, a binder onto one settings namespace, and the
Plugins settings tab dispatches the keyed `settings.plugin.item` slot by that
namespace key; the Host side installs a section with
`settings.installSection(owner, ns, schema, entry, hooks)`. From 0.1.7 the same package
provides `configForms` instead — forms keyed by **profile entry id**, because the
settings document *is* the entry's own configuration — the page is the Plugins page's
`plugins.item` list, and the Host has no `installSection` at all: the editable fields
are the entry's own `Config`, and only the ones marked `.volatile()` are exposed.

Cordis holds an entry `pending` while a service named in its `inject` is missing, and
the web shell requires **every** plugin it loaded to reach the active state before it
starts the page. Naming `settingsScope` therefore did not cost this plugin its card on
0.1.7; it cost the deployment its entire interface, which stopped at *Failed to load
plugins* with nothing on screen to act on.

## Decision

The browser half's `inject` names only `slots`. Both settings transports are then waited
for with an injection of their own — `ctx.inject(['configForms'], …)` and
`ctx.inject(['settingsScope'], …)` — and the first to arrive mounts the card:
`configForms.get(namespace)` together with the `plugins.item` page, or
`settingsScope.bind({ namespace })` together with the keyed `settings.plugin.item`
card — only one card ever mounts. The card answers
`view: 'summary'` before it mounts, because the 0.1.7 page asks for the summary and the
form from the same component.

Waiting, rather than sampling, is the part that took a second release to get right.
`ctx.inject` starts a **child fiber**, which holds nothing back: the entry is active
either way, so a service that never appears costs the card and never the page. Reading the
same service once with `ctx.get` fails in the other direction, and it is not a smaller
version of the bug: 0.1.7's ui-settings injects `['remote', 'remote.settings']`, so it
provides `configForms` strictly *after* this entry applies, and a read taken while
applying finds nothing. 0.9.3 shipped that shape — the GUI booted, the mirror ran, and the
settings card was silently absent from a page that looked perfectly healthy.

The Host half asks by capability for the same reason: `installSection` where the
service has it, the entry's own volatile fields where it does not, and
`configure({ auto: false }, ctx.fiber)` where that policy exists — a plugin that draws
its own page must not also be handed a generated one for the same fields.

## Consequences

- A platform rename costs the card and never the page; a platform *delay* costs nothing at
  all. `tests/client.test.mjs` pins both halves of that rule: the bundle's `inject` is
  exactly `['slots']`, and a case composes `configForms` only after the plugin applied —
  the order 0.1.7 actually applies in — and asserts the card appears.
- The card says which seat it mounted on (`pocket-console: settings card mounted on …`,
  in the page's console). A card that never mounts has no other symptom to read: the page
  loads, the mirror works, and the only evidence is a line that is not there.
- The two write paths have the same four members (`getSnapshot`, `subscribe`, `set`,
  `unset`), which is why one `createSettingsForm` serves both hosts and the card
  itself is unchanged between them.
- The two read paths are *not* equivalent, and the difference is why nothing is cached.
  Up to 0.1.6 a provider hands over a source that re-reads the document and reports
  changes; from 0.1.7 a volatile reference simply reads differently, with no change
  event to re-arm a countdown that is already running. Every access reads, and the
  values that time a countdown are compared on each read so an edit re-times it.
- A `Config` leaf is wrapped in one call of its own (`liveField`) rather than assumed:
  Schemastery 3.18.2, which the 0.1.6 host carries, has no `.volatile()`. That shape is
  why `scripts/check-parity.mjs` tolerates one wrapper before the `z.` that proves a
  line is a schema.
- Nothing changes on ≤ 0.1.6: the transport those Hosts offer is still the one used, and
  `settings.installSection` is still what carries the card's fields there.
