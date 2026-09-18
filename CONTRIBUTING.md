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

## How a change lands

**An issue first, for anything that changes behaviour.** A bug, a new setting, a new
channel, or anything that would move an acceptance rule is worth agreeing on before
anyone writes the code: a change that contradicts the position in the [README](README.md)
or a [decision record](docs/decisions/) is the expensive kind, and it is cheapest to find
that out first. An [issue](https://github.com/picsky/dsh-pocket-console/issues) is the
place for it.

**The exception is part of the rule, not a hole in it.** A typo, a broken link, or a
sentence that says the wrong thing can go straight to a pull request, and so can a fix
that is one line and obviously right. Nobody should have to file a ticket to correct a
word.

Then:

1. **Branch from `main`** and name the branch for the change — `fix/…`, `docs/…`,
   `channel/…`, `feat/…`. Nothing enforces the spelling; it is what makes a list of open
   branches readable.
2. **One topic per pull request.** A pull request is squashed into a single commit on
   `main`, so its description is what the history keeps. Say what was wrong and what the
   change does about it, then say what the diff cannot: what you tried and rejected, what
   is deliberately out of scope, and what still needs a real Feishu tenant to confirm.
3. **Write the commit message as one imperative sentence**, in the voice of the history
   around it — `Open the notice store on first use, so no write can be silently dropped`.
   No `feat:` / `fix:` prefix and no sign-off line; the changelog carries the categories,
   and there is [no CLA to sign](#license).
4. **Wait for the four checks**, and treat the pull request's checklist as the review's
   first pass. All four must be green:

   | Check | What it proves |
   |---|---|
   | `verify (node 22)`, `verify (node 24)` | `npm run check:parity` and `npm test` on both ends of the supported engine range |
   | `real composition` | the packed tarball activates inside a real `dsh web` |
   | `publish payload` | every path the manifest promises exists, and the packed tarball still carries its bundled transport |

   If this is your first contribution here, GitHub holds the workflow until a maintainer
   approves it, so a check sitting at *pending* with no run behind it is expected rather
   than a failure of your change.

   **Do not make a check skippable to save time.** A required check that a diff skips
   stays pending forever on that pull request, which means the pull request can never be
   merged — so all four run on every change, including a docs-only one. A `paths` filter
   is the usual way this is discovered, and it is discovered at the worst moment.

5. **Expect a small, opinionated review.** This is one maintainer's project: the
   turnaround is days rather than hours, and silence is not a decision — a comment on the
   pull request is how to ask for one. Review asks four things before anything else:
   whether the change belongs in the plugin at all, whether it arrives with the case that
   pins it, whether a non-obvious choice has a record, and whether the diff can be
   smaller.

**A pull request can be closed rather than merged.** The usual reasons: it contradicts the
README's position or an existing decision record; it adds a channel concept to the core,
where the fix is the contract instead; or it re-opens a seam that already has one.
[ADR 0009](docs/decisions/0009-a-channel-is-one-file.md) and
[ADR 0006](docs/decisions/0006-binding-is-not-up-for-grabs.md) decide most of these. A
closed pull request is not a verdict on the work — the reasoning is in the thread, and the
same problem is usually welcome in a different shape.

**Neither a security report nor a conduct report is an issue or a pull request.**
[SECURITY.md](SECURITY.md) is the private channel for a hole in an invariant, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is where a report about a person goes.

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

There is no CLA to sign and no DCO sign-off to add. Contributions come in under the same
licence the project ships and go out under it, and every commit keeps its author.
Participation here — issues, discussions, review — is covered by the
[Code of conduct](CODE_OF_CONDUCT.md).
