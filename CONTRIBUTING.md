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
it. `npm run e2e` installs the packed tarball into a scratch `DSH_HOME`, boots
the real `dsh web`, exchanges the printed launch token for the browser cookie,
and reads `/__pocket/state` with it — and checks the same route refuses the same
request without that cookie. It needs the `dsh` release the plugin is verified
against (`npm install -g @deepseek-ai/dsh@0.1.6-alpha.1`) and a network for that
install; everything else stays on the machine. CI runs it in the `composition`
job.

## Publishing

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

**Docs in both languages.** `README.md` is English and the primary document;
`README.zh-CN.md` is its counterpart. Update both.

**A new setting touches five places**, and `npm run check:parity` refuses to pass
until they agree: the `Config` schema in `index.js`, the `SectionSchema` the
Settings card is built from, the card's own `FIELDS` in `client.js`, the config
tables in both READMEs, and the commented example in `cordis.patch.yml`.
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
