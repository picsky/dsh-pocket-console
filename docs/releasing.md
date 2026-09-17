# Releasing

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
2. runs `npm run check:parity`, so the one setting that lives in five places
   cannot ship disagreeing;
3. runs the suite;
4. runs `npm publish --provenance`, whose `prepack` refuses a tarball that lost a
   bundled library or would import a module `files` does not publish.

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

To publish by hand instead, use `pnpm publish` (see CONTRIBUTING) and not `npm
publish`: the tarball's bundled transport is packed from the tree `pnpm install`
created.

## After publishing

```sh
dsh plugin --profile web add dsh-pocket-console@<version>
```

The registry's metadata cache can serve the previous release for a few minutes
after a publish; `pnpm view dsh-pocket-console versions` shows what the registry
is reporting before the install is retried.
