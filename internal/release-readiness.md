# Release readiness

The state of this repository verified against the release path, so the checks do not have
to be re-discovered on release day. Internal — not in `package.json`'s `files`.

Re-run any line with the commands in
[`internal/launch.md`](launch.md) §3.

The process these checks sit inside is [`internal/maintaining.md`](maintaining.md): issue,
branch, pull request, the four required checks, and a two-step release. It is enforced by the
repository's rulesets rather than written down and hoped for —
[ADR 0014](../docs/decisions/0014-the-process-binds-every-change.md).

**Re-measured for 0.9.1**, on the release branch, 2026-09-21. A count in here is a claim about
the moment it was taken, not a property of the repository: re-run a row before relying on its
number.

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Field, default, and published-link parity | `npm run check:parity` | **pass** — 9 config fields agree across Config, SectionSchema, the card, both config pages and the bundle patch; every published document links only to published files; the quoted card-text budget matches `budget.js` |
| 2 | Behaviour suite | `npm test` | **264/264 pass**, no network, no credentials |
| 3 | Manifest covers what it promises | manifest and the tree | **pass** — 35 `files` entries all exist |
| 4 | Bundled transport survives packing | `node scripts/verify-pack.mjs` | **pass** — 19 published modules close over their relative imports |
| 5 | Tarball composition | `pnpm pack` | **4.28 MB packed, 1183 entries**, 82 bundled deps; **36 docs pages and 28 decision records in, 0 `internal/`, 0 `assets/`** |
| 6 | Local links | scan of every `*.md` | **245 relative links across 57 files, 0 broken** — file targets, resolved from each document; anchors are not resolved by this scan |
| 7 | Diagrams render | mermaid's parser | **2 blocks** — `docs/configuration.md` (shipped) and `assets/README.md` (not shipped). **Not re-validated in this release**; the earlier 5/5 result described a tree whose walkthrough diagrams have since left the READMEs |
| 8 | CI action pins exist | GitHub tags API | **verified** — `actions/checkout@v7`, `actions/setup-node@v7` (both have run green on this tree) |
| 9 | CI matrix vs `engines` | — | `[22, 24]` against `^22.19.0 \|\| >=24.0.0` — consistent |
| 10 | Publish cannot ship a broken tarball | `prepack` hook | `verify-pack.mjs` runs from `prepack`, so the tarball a release builds is refused before the registry ever sees it |

## What the 0.9.1 release carries that has not been checked on a real phone

The four required checks are green. Five things are nonetheless **verified only by tests**, and each
has an entry in [`verification-checklist.md`](verification-checklist.md):

- **G6** — the fold holds **this run only** (rewritten for 0.9.1: it used to be "the replied-to run
  plus this one", which is what #64 changed).
- **G7** — a reply that arrives while the session is running enters that turn rather than being
  queued behind it.
- **G8** — a run that errored or hit its output ceiling comes back with a reply box.
- **G9** — two sessions in one project produce titles that differ in the subtitle line.
- **G10** — a session a run delegated work to produces no card of its own (new in 0.9.1, #62).

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
