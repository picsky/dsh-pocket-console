# 0031 — The Host reads the marker, so the plugin writes it

**Status:** accepted.

## Context

From 0.1.7 the settings service projects each entry's own `Config` and exposes only
the fields declared volatile; the Host's own resolve wraps such a field's value in
the live reference the plugin reads with `get()`. Both halves are keyed on one bit,
`schema.meta.volatile`.

The helper that writes that bit, `volatile()`, arrived with a schemastery newer than
this plugin's peer range requires — the peer is `*`, so a profile resolves the
package for itself, and a profile that hoists 3.18.1 beside a 0.1.7 Host hands this
plugin a library without the helper. `liveField` asked for the helper and fell back
to the plain schema, so every editable field landed unmarked: the Host built no form
for the entry, the card could report only that the Host serves no form, and nothing
anywhere said why. The settings were simply not there.

## Decision

**Write the marker rather than request the helper.** `volatile()` is
`extra('volatile', true)` in the library that has both, and `extra` is the older of
the two: 3.18.1 has it, 3.18.4 has it, and the copy a 0.1.6 Host carries has it. So
`liveField` uses the helper when it exists and `extra` when it does not, and the bit
the Host reads is the same either way.

## Consequences

- The form and the live reference both work on either library, which is what the
  support window (`0.1.6-alpha.1`, `0.1.7-rc.2`) assumed and what a deployment's own
  lockfile decides in practice.
- `tests/settings.test.mjs` composes a `Config` from a schema library with the helper
  removed, and fails when the marker is not written — so the case cannot pass by
  request alone.
- The plugin still does not police the version: a profile that resolves an older
  library is an expected shape, not a misconfiguration to report. Asking instead of
  writing cost a blank settings page, which is why the fallback is a write rather
  than a warning.
