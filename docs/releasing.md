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

Until this is configured, `release.yml` fails at the publish step — and it fails in a way worth
recognising, because it names neither the missing configuration nor the registry's refusal of it:

```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

npm does not attempt the OIDC exchange at all without a trusted publisher, so the job looks like
a machine that simply forgot to log in. 0.8.0's first run failed exactly here. Managing the
relationship from the CLI (`npm trust github …`, npm 11.19 and later) needs an authenticated web
session: the granular publish token this repository's hand publishes use answers `403` on the
trust endpoint, so this stays a browser step.

The interim path is a manual `pnpm publish` with a granular access token that has *Bypass
2FA* enabled, which is what earlier releases used.

## Cutting a release

`main` takes changes only through a pull request, so a release is two steps: the version bump
lands like any other change, and the tag then names the commit that landed.

```sh
npm version minor --no-git-tag-version   # writes package.json; commits nothing, tags nothing
```

Move the changelog's **Unreleased** entries into the new version's section, open the pull
request, and title it `Release x.y.z`. Merge it once the four checks are green, then tag the
squash commit it produced:

```sh
git fetch origin
git switch main && git pull --ff-only
git tag -a v0.9.0 -m "Release 0.9.0"
git push origin v0.9.0
```

Two things about that flow are enforced rather than advised. **Only the maintainer can create
a `v*` tag** — a tag is what starts this workflow and therefore what publishes, so a ruleset
restricts creation to the maintainer and blocks updating or deleting tags. And **the tag must
name a commit on `main`**: `npm version minor` followed by `git push --follow-tags`, which is
what this repository did before, tags whatever commit is checked out locally, and the ruleset
now refuses the branch push that flow depended on.

The tag starts the workflow, which:

1. requires the tag to name `package.json`'s version, and the run to be a tag at
   all — a manual dispatch from a branch is refused;
2. requires the tagged commit to be an **ancestor of `origin/main`**, so a tag on a local
   commit or a side branch cannot publish;
3. requires all four of that commit's check runs to have concluded `success`. The branch
   ruleset already required them on the way into `main`; this is the assertion that survives
   the maintainer's bypass, which exists so a broken workflow can still be repaired. A tag
   pushed before `main` is green is refused here, and the recovery is to wait and tag the
   same commit again — re-running the job does not change the answer, because the question is
   about the commit;
4. proves the job holds **no publish token**, so the OIDC exchange is the only
   credential it can be using: a stray `NODE_AUTH_TOKEN` or `NPM_TOKEN` fails the run
   rather than silently turning it back into a token publish;
5. runs `npm run check:parity`, so the one setting that lives in six places cannot
   ship disagreeing, and no published document links to a file the tarball lacks;
6. runs the suite;
7. packs with `pnpm`, then runs `npm publish --provenance`, whose `prepack` refuses a tarball
   that lost a bundled library or would import a module `files` does not publish;
8. reads the version back off the registry and fails if it carries **no provenance
   attestation** — the release asserts what it claims instead of trusting that the
   previous step meant it.

## Publishing by hand

The workflow is the path. This is the fallback for when it cannot run — the trusted
publisher is not configured yet, the tag build is broken while the release is not, or npm
is having a bad day. **0.7.7, 0.7.8, and 0.7.9 were all published this way**, because the
workflow has been failing at the publish step, so this is a route that has been used rather
than a theoretical one.

As of 0.7.9 the workflow had never once completed its publish step, and the reason turned out not
to be the publish at all. `npm publish --provenance` died with npm's own
`Exit handler never called!` — and so did `npm pack --dry-run`, which never goes near the
registry — while `pnpm pack` on the same tree succeeded. **The packer was the culprit, not the
credentials.** `pnpm install` hard-links its store into `node_modules`, and npm 11.19.0 dies on
that tree before it writes anything, while npm 11.6.2 packs hard-link entries the registry then
refuses with `E415`. So the workflow packs with `pnpm pack` and hands the tarball to
`npm publish --provenance`, which is the half npm does correctly; it refuses a tarball carrying
hard links before publishing it. **No release before 0.8.0 carries a provenance attestation** —
that is the property this workflow exists to provide, and it is why the crash was worth chasing
instead of working around with a token. **0.8.0 is the first release the workflow published, and
the first with an attestation.**

That first successful publish still came back as a failed run, for a reason worth knowing: the
registry answered the publish with "Your package is being processed and may take a few minutes to
become available", and the final assertion read the version once, immediately, and got a 404. The
version appeared four minutes later. **A publish that reports success is not yet a version you can
read back**, so the assertion waits for it rather than trusting the first look — and the publish
step leaves a version that is already on the registry alone, so re-running a tag after a failure
that came *after* the upload can still end green.

Two lessons from finding it, both now in the workflow. A crash inside npm's own code says only
that npm crashed, so the workflow dumps npm's debug log when a publish fails — that log is the
one place it records how far it got, and it dies with the runner. And "is it the tool or the
tree" was settled by running the same command through an older npm in the same job: the whole
investigation was three lines of shell.

**A hand publish ships a version number that no commit and no tag names.** That is exactly
how 0.7.8 came to be a byte-for-byte duplicate of 0.7.7: the version was bumped in the
working tree, published, and never committed, so the registry gained a version the history
has no record of and the tag check never saw. Bump and commit the version *before*
publishing, and tag the commit it was published from.

That duplicate also shows what the tag check cannot do. A hand publish never compares the
version against the registry, so it will happily try a version that is already taken — and
the workflow cannot report that either, because it dies before the registry answers. 0.7.8
being taken was found by reading the version list afterwards, which is why the fix meant for
0.7.8 shipped as 0.7.9. `pnpm view dsh-pocket-console versions` costs one command and belongs
before the publish, not after it. (The duplicate was deprecated once 0.7.9 was out: the
registry tells an installer what it is.)

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
