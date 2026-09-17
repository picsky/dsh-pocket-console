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

## After publishing

```sh
dsh plugin --profile web add dsh-pocket-console@<version>
```

The registry's metadata cache can serve the previous release for a few minutes
after a publish; `pnpm view dsh-pocket-console versions` shows what the registry
is reporting before the install is retried.
