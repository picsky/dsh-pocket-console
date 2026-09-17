# Development

Plain ESM JavaScript, **no build step** — nothing here compiles, and the tests need no
install. Publishing is the one operation that touches dependencies: the transport and
the QR encoder are bundled into the tarball (`bundleDependencies`), so `pnpm install`
runs before `pnpm pack`/`pnpm publish`, and the consumer's profile then resolves nothing
that needs a build permission. `prepack` refuses to build a tarball without the
transport in it.

```sh
npm test
```

## The suite

Nothing to install first: the suite replaces its five production dependencies through a
Node module resolution hook (`tests/fixtures/hooks.mjs`), so it needs no credentials and no
network. Cases live under `tests/`, one file per domain over the shared harness in
`tests/support/harness.mjs`; the hook and the dependency stubs it installs sit in
`tests/fixtures/`.

| File | What it holds |
|---|---|
| `settings.test.mjs` | The settings namespace, the same-origin routes, the trust fence, and a service that arrives after load |
| `binding.test.mjs` | The unbound → awaiting → bound state machine, unbind, and the race with a late scan |
| `enrollment.test.mjs` | What the card may claim about a connection, and when |
| `escalation.test.mjs` | Timing, the desktop-first race, cancellation, disposal, the pending report |
| `channel-contract.test.mjs` | The three ways a request must not be left waiting on a message |
| `questions.test.mjs` | Option, multi-select, free-text, accumulation, forged input, the byte budget |
| `notices.test.mjs` | Result notices: delivery, suppression, cooldown, supersession |
| `notices-memory.test.mjs` | The per-session record's bound, which is what keeps a weeks-long process flat |
| `messages.test.mjs` | Both dictionaries carrying the same keys, and dead copy staying dead |
| `notices-memory.test.mjs` | The per-session record's bound, which is what keeps a weeks-long process flat |
| `client.test.mjs` | The browser half: module-table load, the settings card, the desktop mirror, and its accessibility |

71 cases. A file beginning `_` is scratch — it is ignored by the suite's glob and is
not part of the project; delete it rather than commit it. What the cases cover, in one
line each, is enumerated in [CHANGELOG.md](../CHANGELOG.md)'s most recent entry and in
the git history of `tests/` — the suite is meant to be read as the specification of the
seams, so a new behaviour arrives with the case that pins it.

## The real-composition check

`npm test` builds its own context. That is the right shape for behaviour and the wrong
shape for activation: a hand-built context does not enforce Cordis's service rules, so a
plugin that reads an undeclared service, misnames an export, or never activates still
passes — and then fails on the machine that installed it.

`npm run e2e` is the other half, and it is what CI's `real composition` job runs: it
packs the tree with `pnpm` — the tool a release publishes with, so the tarball it
installs is the one a release builds — installs that tarball into a scratch `DSH_HOME`,
then boots the real `dsh web` and exchanges its launch token for the browser cookie. That
is the only check that proves the plugin **activates** inside the real Loader. It needs
`pnpm install` first (the tarball bundles its transport) and the `dsh` release named in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Debugging against a live deployment

Point `channel` at a relative path to run a local overlay instead of the published
transport:

```yaml
- insert:
    - id: pocket-console
      name: ./index.js
      config:
        channel: ./providers/feishu.js
```

The plugin logs under the `pocket-console:` prefix. Routine decisions — why an
escalation was skipped, what the mirror did — are at **debug**, so a running deployment
does not read them; turn the deployment's log level up and the full account comes back,
including the Feishu SDK's own connection chatter.

## Where the rest lives

- [CONTRIBUTING.md](../CONTRIBUTING.md) — what a change needs, and the six places one
  setting lives in.
- [CHANGELOG.md](../CHANGELOG.md) — what changed, and when.
- [docs/decisions/](decisions/) — why the plugin is shaped the way it is.
- [docs/releasing.md](releasing.md) — the tag-driven release and the npm-side setup.
- [SECURITY.md](../SECURITY.md) — the invariants, and how to report a hole in one.
- [providers/README.md](../providers/README.md) — the channel contract, for a transport
  that is not Feishu.
- `internal/launch.md` — the release-and-announcement checklist. Deliberately not
  published; `check-parity` refuses a published document that links into it.
