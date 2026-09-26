# 0032 — A stand-in is held to the Host's own contract

**Status:** accepted.

## Context

The suite stands in for seven production dependencies, and it does not install the
Host: `tests/fixtures/stubs-loader.mjs` redirects each bare specifier to a file in this
repository, and the plugin itself is loadable with nothing installed. That is what makes
the suite able to run anywhere, and it is also how a plugin can be broken for every real
deployment while every case passes.

It happened. `volatileForm` — the Host's gate on whether an entry has a settings form at
all — reads `schema.meta.volatile`
(`@deepseek-ai/dsh-settings` `lib/index.js:118-131`). The schemastery stand-in modelled
volatility as its own `isVolatile` boolean, and `liveField` asked for a `volatile()`
helper instead of writing the marker. On a profile that resolved a schemastery older
than the Host's own — a legitimate resolution, because this plugin's peer range is `*`
and the Host's compatibility gate skips every peer that is not `@deepseek-ai/dsh-*` —
the helper was absent, no marker was written, the Host built no form for the entry, and
the Plugins page listed the plugin with nothing to edit. 277 cases passed, the release
gate passed, and the first report came from a person looking at the page.

Two things were true at once, and each is enough on its own:

- **The stand-in was not the Host.** Nothing compared the two, so the divergence was
  invisible by construction. The failure lived in exactly the gap.
- **The suite never asked the question a person asks.** It asserted that a value was
  marked, never that a *form* existed. The marker is the mechanism; the form is the
  thing a person sees.

## Decision

**A stand-in is held to the Host's own contract, and the contract lives in the
repository as executable code.**

1. `tests/support/host-contract.mjs` transcribes the Host's gate —
   `volatileForm`, `plainSchema`'s effect on `meta`, `describe()`'s admission test, the
   live reference a marked field resolves to — each with the file and line it was read
   from. A case asserts against those functions, so a stand-in can only be wrong in a
   way that fails a test. `tests/support/host-schema.mjs` is the other half and the one a
   build can run inside a profile: the same marker rules as a walk over the entry's own
   `Config`, plus the resolution calls asked **of the library the deployment resolved** —
   the two questions the composition job needs answered.
2. **Cases assert the user-visible exit.** `formOf(Config)` answers "is a form served,
   and with which fields", and that is what a case about the settings surface asserts —
   not "was the marker written".
3. **The stand-in models the library's axes, not just its happy shape.** Volatility is
   `meta.volatile`; `extra()` returns a copy with a fresh `meta`; `resolve()` follows
   the marker at the node it sits on. A case can remove the helper to model a library
   older than the Host's, because that shape is a resolution a deployment may really
   make.
4. **The real composition asks the same question.** `scripts/probe-installed-form.mjs`
   runs inside the installed profile, imports the schema library that deployment
   resolved, evaluates the plugin's shipped `liveField` and `Config` against it, and
   reports the fields the Host would offer. `scripts/e2e-profile.mjs` fails the build
   when the form is not served. No stand-in can see this failure — the point is the
   library the deployment resolved — so this is the one place it is asked for real.

## Consequences

- `check:parity` holds the marked set to `Config`'s `SectionSchema` and to the card's
  own `FIELDS`. Since `index.js` turns the Host's generated page off with
  `configure({ auto: false })`, the marked set *is* the settings surface: a field marked
  and absent from the card is editable on no surface at all, and a card field left
  unmarked is a control the Host never sends.
- `check:parity` also refuses a required field with no default. `plainSchema` keeps
  `meta.required`, so such a field is a form the Host serves and the browser can never
  bring to ready — served, visible, unusable, which reads as a broken plugin.
- A capability the plugin asks for by name is decided by capability and not by version,
  which is what lets one artifact load across the support window — so a capability that
  is missing has to leave a trace a deployment operator can read. The settings service
  reports the two probes it makes when neither answers.
- **A Host rename is a test failure, not a production surprise.** The cost is that a
  stand-in has to be maintained against the Host it stands in for: a case that fails
  because the Host moved is the mechanism working, and the fix is to re-read the Host's
  source and update the transcription with its new line numbers.
- The evidence for a defect of this class includes the negative: the case is run against
  the previous code and shown to fail. A case that has never been red is a case nobody
  has seen work.
