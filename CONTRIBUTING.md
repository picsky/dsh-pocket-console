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

`npm test` builds its own context, and that is the wrong shape for activation: a hand-built
context does not enforce Cordis's service rules, so a plugin that reads an undeclared
service, misnames an export, or never activates still passes — and then fails on the machine
that installed it. `npm run e2e` is the check that closes that gap, by installing the packed
tarball into a scratch `DSH_HOME` and booting the real `dsh web`.

It is what CI's `composition` job runs, and [docs/development.md](docs/development.md) says
what it does at each step and what it needs. `npm test` staying green is not a substitute
for it: a change that touches activation, the manifest, or the published file list wants
both.

## Publishing and releasing

Maintainer work, and it has one home: [docs/releasing.md](docs/releasing.md). That page
covers the one-time trusted-publisher setup on npm, what the tag-driven workflow checks
before it publishes, how to publish by hand when the workflow cannot run, and what to do
when npm itself falls over.

Two things about the payload are worth knowing from here, because they constrain what a
change may do rather than only how a release is cut:

**The published tarball must carry every runtime library inside it.**
`package.json`'s `bundleDependencies` embeds `@larksuiteoapi/node-sdk` — and through it
`protobufjs`, `axios`, and `ws` — and `qrcode` as well, so a consumer's profile resolves
nothing that needs a build permission. Packing without an install produces a tarball with
none of it and no warning, which is why `scripts/verify-pack.mjs` refuses from `prepack`.

**Only `pnpm` can build that tarball.** `pnpm-workspace.yaml` pins the hoisted linker the
bundle needs and declines `protobufjs`'s no-op postinstall for this repository's own
install — the same decision a consumer installing from git has to make for themselves. A
tarball built by `npm pack` is refused by the registry outright; `docs/releasing.md` says
why.

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

**Docs in both languages, or in one with a reason.** `README.md` is English and the
primary document; `README.zh-CN.md` is its counterpart, and a change to one belongs in the
other. Two reference pages are also paired: `docs/configuration.md` with
`docs/zh-CN/configuration.md`, and `docs/troubleshooting.md` with
`docs/zh-CN/troubleshooting.md`. Everything else — the decision records,
`docs/development.md`, `docs/releasing.md`, `SECURITY.md`, `CHANGELOG.md`, this file — is
English only, on the same reasoning that the source, the commit messages, and the issue
tracker are: one copy to keep true. `README.zh-CN.md` says so at the top, and a request
for another translated page is a worthwhile issue rather than a silent gap.

`providers/README.md` is the exception, and it is the wrong way round: the channel
contract is written in Chinese while every document around it is English, so a reader who
follows the link from either README meets a wall. It is being translated; until then, treat
a Chinese page in an English-only set as a defect rather than a precedent.

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

For a security issue, do not open a public issue, a discussion, or a pull request.
[SECURITY.md](SECURITY.md) is the channel: GitHub's private vulnerability reporting, which
keeps the report private while it is worked on. That file also lists what is in scope and
the invariants a report should be measured against.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
