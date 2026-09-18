# Releasing

[← All documentation](README.md)

Publishing runs from a tag through npm's **trusted publishing**: the workflow
exchanges its GitHub OIDC identity for a short-lived publish credential, so no
npm token exists in this repository, in a secret, or on anyone's machine, and
every release carries a signed provenance statement.

## One-time setup on npm

This is the only step that cannot be automated from the repository, because it
happens in the package owner's npm account:

1. Sign in at [npmjs.com](https://www.npmjs.com/) as the package owner.
2. Open the package `dsh-pocket-console` → **Settings** → **Trusted Publisher**.
3. Choose **GitHub Actions** and fill in exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `picsky` |
   | Repository | `dsh-pocket-console` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave empty)* |

4. Save. Publishing access may then be set to **Require two-factor
   authentication and disallow tokens**, which is the point: a leaked token can
   no longer publish this package.

Until this is configured, `release.yml` fails at the publish step; the interim
path is a manual `pnpm publish` with a granular access token that has *Bypass
2FA* enabled, which is what earlier releases used.

## Cutting a release

```sh
npm version minor          # or patch / major; writes package.json and commits
git push --follow-tags     # pushes the commit and the v<version> tag
```

The tag starts the workflow, which:

1. requires the tag to name `package.json`'s version, and the run to be a tag at
   all — a manual dispatch from a branch is refused;
2. proves the job holds **no publish token**, so the OIDC exchange is the only
   credential it can be using: a stray `NODE_AUTH_TOKEN` or `NPM_TOKEN` fails the run
   rather than silently turning it back into a token publish;
3. runs `npm run check:parity`, so the one setting that lives in six places cannot
   ship disagreeing, and no published document links to a file the tarball lacks;
4. runs the suite;
5. runs `npm publish --provenance`, whose `prepack` refuses a tarball that lost a
   bundled library or would import a module `files` does not publish;
6. reads the version back off the registry and fails if it carries **no provenance
   attestation** — the release asserts what it claims instead of trusting that the
   previous step meant it.

## Publishing by hand

The workflow is the path. This is the fallback for when it cannot run — the trusted
publisher is not configured yet, the tag build is broken while the release is not, or npm
is having a bad day. **0.7.7, 0.7.8, and 0.7.9 were all published this way**, because the
workflow has been failing at the publish step, so this is a route that has been used rather
than a theoretical one.

**A hand publish ships a version number that no commit and no tag names.** That is exactly
how 0.7.8 came to be a byte-for-byte duplicate of 0.7.7: the version was bumped in the
working tree, published, and never committed, so the registry gained a version the history
has no record of and the tag check never saw. Bump and commit the version *before*
publishing, and tag the commit it was published from.

**Use `pnpm publish`, not `npm publish`.** Two separate reasons, and both are fatal:

- **`npm publish` cannot pack this tree at all.** pnpm hard-links its store into
  `node_modules`, so a tarball built by `npm pack` carries hard-link entries — 1047 of its
  1133 files. The registry refuses it with `E415 Hard link is not allowed`, because a
  hard-linked file in a package is a known supply-chain trick. `pnpm pack` writes the same
  content with no link entries. The repository's own `pnpm-workspace.yaml` sets
  `nodeLinker: hoisted` for the bundled transport, but that controls *layout*, not how
  pnpm copies from its store.
- **The bundled transport is packed from the tree `pnpm install` created**, so the payload
  a release ships is the payload `pnpm pack` builds. `npm run e2e` packs with `pnpm` for
  the same reason.

```sh
pnpm install          # the one step that needs the network, and what fills the bundle payload
npm test
pnpm publish          # needs a credential this machine can use: `npm login`, or a
                      # granular access token with "Bypass 2FA" enabled
```

Two things a hand publish does **not** get you, and both are worth knowing before choosing
it: npm generates **no provenance attestation** off a supported CI provider (`npm publish
--provenance` fails with `Automatic provenance generation not supported for provider:
null`), and nothing checked the tag against the version first. Verify the version landed
afterwards — see below.

## When npm itself falls over

npm 11 can end an otherwise successful operation with:

```
npm error Exit handler never called!
npm error This is an error with npm itself.
```

It is a crash in npm's own shutdown, seen on CI runners in both `npm pack` and
`npm publish`, and it says nothing about this package. Before retrying, find out
what actually happened:

- for a pack, the tarball is usually written anyway — CI's `npm run e2e` packs with
  `pnpm` (the tool a release publishes with) and only falls back to npm, where it
  accepts this one crash when the tarball exists, because installing and booting
  that tarball is what the check asserts;
- for a publish, check the registry first — `pnpm view dsh-pocket-console versions`
  — because the version may have been published before npm fell over. Publishing it
  again is refused as a duplicate, and re-running the job is the safe move when it
  did not land.

One more way the local tooling misleads: a client can print its success line for a publish
the registry never accepted. **Read the registry, not the tool's summary** — a version is
published when `pnpm view dsh-pocket-console versions` lists it.

## After publishing

```sh
pnpm view dsh-pocket-console versions      # the registry, which is the authority
dsh plugin --profile web add dsh-pocket-console@<version>
```

The registry's metadata cache can serve the previous release for a few minutes
after a publish; `pnpm view dsh-pocket-console versions` shows what the registry
is reporting before the install is retried.

Then, if the release went out by hand, check that CI publishes the **next** one — the
workflow only proves itself when it is the thing doing the work.
