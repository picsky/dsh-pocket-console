# Contributing

Thanks for considering a contribution. This plugin is small on purpose: a
channel-neutral core, one transport, and a browser card.

## Getting set up

There is no build step and nothing to install for development — the suite
replaces its five production dependencies with in-repo stubs through a Node
module resolution hook. Cases live under `tests/`, one file per domain, over a
shared harness (`tests/support/harness.mjs`); `node --test` runs them in
parallel.

```sh
git clone https://github.com/picsky/dsh-pocket-console
cd dsh-pocket-console
npm test
```

To exercise it against a real `dsh web`, install the working copy into a profile
and point the overlay at it:

```sh
dsh plugin --profile web add .
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: pocket-console
  config:
    channel: ./providers/feishu.js
```

```sh
dsh web
```

## The real-composition check

`npm test` builds its own context. That is the right shape for behaviour and the
wrong shape for activation: a hand-built context does not enforce Cordis's
service rules, so a plugin that reads an undeclared service, misnames an export,
or never activates still passes — and then fails on the machine that installed
it. `npm run e2e` packs the tree with `pnpm` (the tool a release publishes with,
so the tarball it installs is the one a release builds), installs that tarball into
a scratch `DSH_HOME`, boots the real `dsh web`, exchanges the printed launch token
for the browser cookie, and reads `/__pocket/state` with it — and checks the same
route refuses the same request without that cookie. It needs `pnpm install` first
(the tarball bundles its transport), the `dsh` release the plugin is verified
against (`npm install -g @deepseek-ai/dsh@0.1.6-alpha.1`), and a network for that
install; everything else stays on the machine. CI runs it in the `composition`
job.

## Publishing

See [docs/releasing.md](docs/releasing.md) for the tag-driven release, the one-time
trusted-publisher setup on npm, and what the workflow checks before it publishes.

The short version:

The published tarball must carry every runtime library inside it. `package.json`'s
`bundleDependencies` embeds `@larksuiteoapi/node-sdk` — and through it
`protobufjs`, `axios`, and `ws` — and `qrcode` as well, so a consumer's profile resolves nothing that
needs a build permission. Packing without an install produces a tarball with
none of it and no warning, so `scripts/verify-pack.mjs` refuses from `prepack`.

```sh
pnpm install     # the one step that needs the network, and what fills the bundle payload
pnpm test
pnpm publish     # or: pnpm pack, then dsh plugin add ./dsh-pocket-console-<version>.tgz
```

`pnpm-workspace.yaml` pins the hoisted linker the bundle needs and declines
`protobufjs`'s no-op postinstall for this repository's own install — the same
decision a consumer installing from git has to make for themselves.

## Releasing

The first release is published by hand, because npm configures trusted
publishing on a package that already exists:

```sh
pnpm install
pnpm test
pnpm publish     # needs a credential this machine can use: `npm login`, or a
                 # granular access token with "Bypass 2FA" enabled
```

Every release after that is token-free. `.github/workflows/release.yml`
publishes on a `v*` tag through npm's **trusted publishing**: the job exchanges
its GitHub OIDC identity for a short-lived credential, so no token lives in this
repository, in a secret, or on a maintainer's machine.

One-time setup, on npm: the package's settings → **Trusted Publisher** → GitHub
Actions, naming repository `picsky/dsh-pocket-console` and workflow
`release.yml`. Then:

```sh
npm version patch        # or minor / major; commits and tags the bump
git push --follow-tags
```

## What a change needs

**Tests.** `npm test` must stay green, and new behavior needs a case. The suite
runs a fake Host context, a stubbed Feishu SDK, and a stubbed QR encoder, so
most behavior is testable without credentials or network. If you touch the
browser half, the load-and-register case executes `client.js` against a
stand-in shell that seeds only what the real shell seeds — React and the UI
primitives. That is the whole module table: a request for anything else fails
the page's boot rather than this card's, and which package owns a shared engine
has moved between DSH releases (the store engine lived in the client runtime,
then in a client store package). Carry what the card needs in the bundle.

**A channel that is not Feishu.** Add one file under `providers/`, implement the
contract in [`providers/README.md`](providers/README.md), and document it. Do
not add transport concepts to `index.js` — if a change needs the core to know
what Feishu is, the contract is missing something and that is the real fix.

**A non-obvious choice gets a record.** `docs/decisions/` holds short records of
why the plugin is shaped the way it is — the no-build-step constraint, the
browser-side mirror, the human attribution of a phone instruction, the single-file
browser half. Change one and the record changes with it. A record is warranted when
the decision is invisible from either file that implements it: the prepend-and-race
ordering ([0007](docs/decisions/0007-prepend-and-race-the-desktop.md)) and the rule
that a direct message binds but never re-binds ([0006](docs/decisions/0006-binding-is-not-up-for-grabs.md))
are both unreadable from the code alone.

**A user-visible change moves the changelog.** [CHANGELOG.md](CHANGELOG.md) is what a
deployment reads before upgrading, so a fix, a behaviour change, or a security
property belongs there — under **Unreleased** until the version is bumped. A
behaviour change that could surprise someone gets its own line even when the commit
is one sentence.

**A security property is a claim, not a comment.** If a change adds or weakens one —
who may answer, what a card may carry where a secret lives — the invariant list in
[SECURITY.md](SECURITY.md) is part of the change, and a case in `tests/` is what
holds it.

**`internal/` is not published.** It holds maintainer notes — starting with
`internal/launch.md`, the release and announcement checklist. It is deliberately absent
from `package.json`'s `files`, so an installer never carries it, and `npm run
check:parity` refuses a *published* document that links into it: this file is published,
so it names the path rather than linking it. That boundary is the point — a note a
reader of the package needs belongs in `docs/`, not there.

**Docs in both languages.** `README.md` is English and the primary document;
`README.zh-CN.md` is its counterpart. Update both. They are the only bilingual
documents: `docs/` (the reference pages and the decision records), `SECURITY.md`,
`CHANGELOG.md`, this file, and `providers/README.md` are English-only, on the same
reasoning that the source, the commit messages, and the issue tracker are — one copy
to keep true. `README.zh-CN.md` says so, and a request for a translated page is a
worthwhile issue rather than a silent gap.

**A new setting touches six places**, and `npm run check:parity` refuses to pass
until they agree: the `Config` schema in `index.js`, the `SectionSchema` the
Settings card is built from, the card's own `FIELDS` in `client.js`, the config
tables in `docs/configuration.md` and `docs/zh-CN/configuration.md`, and the
commented example in `cordis.patch.yml` — and it holds them to the same
**defaults**, not only the same names, because a documented default that disagrees
with the code is read as a promise.
`SectionSchema` carries the user-tunable subset; the card, the tables, and the
example follow it, so a key that exists only in `Config` stays deployment-only.

**No secrets in the environment.** Anything a plugin reads from `process.env` is
readable by every command the agent runs. Credentials belong in the credential
store, referenced by name.

## Style

- Plain ESM JavaScript, no TypeScript and no bundler. This is deliberate: it is
  what keeps the package itself free of build scripts, so installing it from
  npm, a tarball, or a raw git URL never builds it. Dependencies are still gated
  by pnpm ≥11 — the Quick start carries the one `allowBuilds` entry the Feishu
  SDK's `protobufjs` needs.
- Comment the contract, not the code. Say what a caller must know — ownership,
  failure, timing — and delete anything that restates the line below it.
- Prefer a clear name over a clever one.
- Keep the core free of channel vocabulary.

## Reporting a problem

Open an [issue](https://github.com/picsky/dsh-pocket-console/issues) with:

- your `dsh --version` and Node version
- your platform
- the plugin's log lines (the `pocket-console:` prefixed ones)
- what you expected and what happened

For a security issue, do not open a public issue — email the maintainer
listed on the repository profile.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
