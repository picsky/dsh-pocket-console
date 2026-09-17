# Release readiness

The state of this repository verified against the release path, so the checks do not have
to be re-discovered on release day. Internal — not in `package.json`'s `files`.

Re-run any line with the commands in
[`internal/launch.md`](launch.md) §3.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Field, default, and published-link parity | `npm run check:parity` | **pass** — 8 config fields across 6 places, every published document links only to published files, every rendered visual resolves |
| 2 | Behaviour suite | `npm test` | **65/65 pass**, no network, no credentials |
| 3 | Manifest covers what it promises | `npm pack --dry-run` | **pass** — 23 `files` entries all exist |
| 4 | Bundled transport survives packing | `node scripts/verify-pack.mjs` | **pass** — 9 published modules close over their relative imports |
| 5 | Tarball composition | `npm pack --dry-run` | 4.3 MB packed / 41.6 MB unpacked, 1152 files, 81 bundled deps; **16 docs files in, 0 `internal/`, 0 `assets/`** |
| 6 | Local links | scan of every `*.md` | **83 links across 25 files, 0 broken** |
| 7 | Diagrams render | mermaid's own parser | **5/5 valid** (4 sequence, 1 state) |
| 8 | CI action pins exist | GitHub tags API | **verified** — `actions/checkout@v6`, `actions/setup-node@v6`, `pnpm/action-setup@v6` |
| 9 | CI matrix vs `engines` | — | `[22, 24]` against `^22.19.0 \|\| >=24.0.0` — consistent |
| 10 | Publish cannot ship a broken tarball | `prepack` hook | `verify-pack.mjs` runs on `npm publish`, so a tarball that lost its transport is refused before npm receives it |

## What is not checked here, and why

- **A real Feishu tenant.** The one-scan app creation, the long connection, card delivery,
  and card actions arriving back were verified against a live tenant during development.
  The card-action field path, the one-option-per-row layout, and typed answers shipped
  after that pass; the suite covers them and a phone still has to confirm them.
- **A second channel.** `providers/feishu.js` is the only implementation, so the channel
  contract is documented but not yet exercised by a second file.
- **The npm package page.** Images now use absolute urls for it, which is the fix for the
  known npm re-hosting behaviour, but the page itself can only be confirmed after a
  release that carries an image.

## Hand-off

Three things cannot be done from inside this repository, and each is a prerequisite for
the next:

1. **Record `assets/demo.gif`** — the plan is `assets/demo-storyboard.md` and
   `assets/README.md` §3. The READMEs already hold the insertion point, commented, with
   the absolute url in place.
2. **Add the `dsh-plugin` GitHub topic** — there is no official registry; that topic is
   the de-facto one, and several marketplaces scrape it daily.
3. **Publish and announce** — `internal/launch.md` §2 (metadata), §3 (publishing), §4
   (channel order), §4b (the bodies to paste).
