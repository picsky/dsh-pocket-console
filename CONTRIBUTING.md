# Contributing

Thanks for considering a contribution. This plugin is small on purpose: a
channel-neutral core, one transport, and a browser card.

## Getting set up

There is no build step and nothing to install for development — the suite
replaces its four production dependencies with in-repo stubs through a Node
module resolution hook.

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

## What a change needs

**Tests.** `npm test` must stay green, and new behavior needs a case. The suite
runs a fake Host context, a stubbed Feishu SDK, and a stubbed QR encoder, so
most behavior is testable without credentials or network. If you touch the
browser half, the load-and-register case executes `client.js` against a
stand-in shell.

**A channel that is not Feishu.** Add one file under `providers/`, implement the
contract in [`providers/README.md`](providers/README.md), and document it. Do
not add transport concepts to `index.js` — if a change needs the core to know
what Feishu is, the contract is missing something and that is the real fix.

**Docs in both languages.** `README.md` is English and the primary document;
`README.zh-CN.md` is its counterpart. Update both.

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
