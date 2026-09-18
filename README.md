# dsh-pocket-console

**Don't hand over the whole machine — hand over the one decision blocking it.**

When you leave your desk, an unattended [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
run doesn't fail — it **waits**. `dsh-pocket-console` forwards only the moments that need a human
(tool-call approvals and `ask_user_question` prompts) to your phone as Feishu cards, and only after
the desktop has had its chance to answer. Nothing moves to your phone except the decision itself.

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![CI](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml/badge.svg)](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

English · [简体中文](README.zh-CN.md)

> **Unofficial project.** Independently developed and maintained by community members — not affiliated with DeepSeek, and not reviewed or endorsed by it. Evaluate any third-party plugin before you install it.

---

## Three things that define it

- **Desktop first, by default for 120 seconds.** Every request reaches the desktop GUI first. Answer
  there and your phone is never touched. Only after `delaySeconds` with no answer does the same request
  go out as a Feishu card with buttons. A notification you didn't need is worse than no notification.
- **The phone gets a one-time decision, and nothing else.** A card shows the request, the reason and the
  options. Approving grants `allowed-once` — the same thing the desktop button grants — and the random id
  that carries it dies the moment the request settles. No workspace, no session list, no settings,
  no credentials. The blast radius of a lost phone is *one answer*.
- **Outbound only.** One WebSocket long connection to Feishu. No public IP, no domain, no certificate,
  no port forwarding, no tunnel, no relay. Nothing of yours becomes reachable from the internet.

## Quick start

The published tarball carries its Feishu transport inside it, so the install resolves nothing that needs
a build permission and runs no install-time script:

```sh
dsh plugin --profile web add dsh-pocket-console
```

Then restart `dsh web` and open **Settings → Plugins → Plugin configuration → Pocket console**:

1. Click **Create an app by scanning**, or **Use an existing app**.
2. Scan the QR code with Feishu (the link is valid for 10 minutes and can be used once).
3. The card reports **Bound** and lists the app, the recipient, and whether the long connection is up.

That is the whole setup. Application credentials and recipient id live in the credentials store, so every
later `dsh` start reconnects the long connection by itself — no settings visit, no second scan.

**No scan at all** is also possible: put the app credentials in the credentials store under
`DSH_FEISHU_APP_ID` / `DSH_FEISHU_APP_SECRET` (the names `appIdRef` / `appSecretRef` point at).

Install from GitHub works too, but a git dependency has pnpm resolve the channel's own dependencies, and
`protobufjs`'s postinstall will stop the first install on pnpm ≥ 11. Set the placeholder pnpm appends to
the profile's `pnpm-workspace.yaml` to `false` and retry:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  protobufjs: false
```

To remove it: `dsh plugin --profile web remove dsh-pocket-console`.

### Retuning it

Every setting has a schema default, so this plugin works with no configuration at all. To tune a
deployment, override the row in your own profile layer — a patch replaces the row's entire `config`,
so restate every key you want to keep:

`$DSH_HOME/profiles/web/cordis.patch.yml`

```yaml
- id: pocket-console
  config:
    channel: dsh-pocket-console/providers/feishu.js
    channelConfig: {}
    delaySeconds: 120
    titlePrefix: DSH
    resultNotify: idle
    resultNotifyCooldownSeconds: 0
    mirrorTtlSeconds: 60
    locale: zh
```

That is every key at the value the code already ships, so copying it changes nothing.
`delaySeconds` is the one worth thinking about: it is the desktop's head start, and `0` makes both
sides live at once. `npm run check:parity` holds this example, both config pages, the plugin schema,
the Settings card and the bundle patch to the same names *and* the same defaults.
[Every setting](docs/configuration.md) documents the rest.

## Where the data goes

```
approval/request          ─┐
                           ├─→ dsh-pocket-console ─→ Feishu long connection ─→ your phone
user-questions/request    ─┘         │
                                     └─→ next() → the desktop GUI
```

The plugin registers with `prepend: true` on both waterfalls and **calls `next()` first**, so the desktop
chain runs exactly as it would have. The two answers race: whichever settles first wins. A delivery
problem cannot change the answer — if the channel is down, the escalation abandons the phone side and
leaves the desktop racing alone rather than settling the request with an answer nobody gave.

There is no server of ours in this path, and no third party sees the request. Feishu sees the card,
because Feishu is the transport.

## Which of these is this?

| | Transports | Phone gets | You must operate | Fits |
|---|---|---|---|---|
| **Desktop GUI mirroring** — [dsh-pocket](https://github.com/shaobeichen/dsh-pocket), [ds-harness-remote](https://github.com/liguobao/ds-harness-remote), [dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) | the whole Web GUI over LAN, tunnel, P2P or hosted relay | the full interface: workspaces, sessions, settings, credentials | a tunnel, a relay, a domain, or trust in someone's relay | working away from the computer |
| **IM console** — [dsh-im](https://github.com/xmanrui/dsh-im), [dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot) | chat platform long connections | sessions, workspaces, models, permissions; several channels | a bot app, often a developer-console walkthrough | driving the agent from chat |
| **Notification only** — [dsh-turn-notify](https://www.npmjs.com/package/dsh-turn-notify), [@dsh-suite/plugin-notify](https://www.npmjs.com/package/@dsh-suite/plugin-notify) | toast, browser, webhook, Bark, ServerChan | a message it cannot answer | per-channel webhook or key | knowing when something happened |
| **dsh-pocket-console** | one outbound WebSocket | **one decision, single-use** — approve, reject, or answer | nothing | an agent that must not stall while you are away from the desk |

If you want the computer in your hand, install one of the first row. This plugin is for the case where
the computer stays where it is and only the **decision** travels.

## What it deliberately does not do

Each of these is a limitation you may be looking for — in which case, the right tool is named above.

- **No GUI mirroring.** Moving the interface would move the workspace, the settings and the credentials.
- **No multi-session management or history.** Those exist to work from the phone; this is for deciding.
- **No push to the phone by default.** A card lands only when the desktop hasn't answered in time.
- **No persistent authority on the phone.** Authorization is `allowed-once`, so no permission can accumulate.
- **No auto-approval, ever.** The plugin never decides in your place: silence never approves.
- **No changes to DSH.** It ships as a `dsh.bundle` profile layer and registers on two documented
  waterfalls. Nothing in the harness is patched or forked, and a DSH upgrade cannot break it.
- **No inbound listener.** No port, tunnel, relay, or third-party server — so also no "reachable from anywhere".
- **No single-direction channels.** A transport that cannot answer (`supportsForms: false`) can only notify
  and is out of this plugin's scope.

## Security

An approval card is a **remote code-execution authorization channel**, so it is built like one:

- **Grants are single-use.** `allowed-once` applies to that call only; the random `rid` dies once the request settles.
- **Secrets never go in environment variables.** Every command the agent runs inherits the process
  environment and could read them. Credentials live in `$DSH_HOME/.credentials.yaml`.
- **The app asks for the minimum.** The minimum base (`addons.preset: false`, bot capability only) plus
  three permissions, one event and one callback — not the default template's cloud-doc and wiki permissions.
- **Only the bound recipient can press.** The card is itself a credential, so the operator `open_id` must
  equal the bound recipient. A private chat only binds an unbound deployment, and group messages never bind.
- **Callback fields are strictly validated.** Buttons carry a single-use `rid`, and an answer must come
  from an option the question actually offered.
- **Credentials are verified before use.** The channel exchanges a tenant token first; only on success does
  it connect, so a wrong App ID or Secret is shown on the card instead of retrying forever.
- **Routing is behind the connection's trust fence.** Every `/__pocket` route answers only when the
  connection accepts the request; cross-site writes are refused.

Full invariants, threat model and reporting: [SECURITY.md](SECURITY.md).

## Limitations

These are honest gaps, not choices. The choices are in the previous two sections.

- **Mirroring to the desktop needs the page open.** The browser half replays the same client call a click
  makes, so the panel closes instead of waiting for a decision that already happened. With no page open the
  answer still reaches the model and the session log, but a page opened later will not replay it — the
  mirror is only valid for a minute.
- **Card text is limited by bytes, not characters.** A Feishu card request body caps at 30 KB and a CJK
  character costs 3, so text is held under 9 KB and truncated explicitly. A very long plan review arrives
  as its opening section; the decision buttons still work.
- **Idle notices do not wake a reclaimed session.** If the host has already released the agent, the notice
  is skipped and logged rather than resurrecting the session.
- **One Feishu app serves one DSH instance.** Long-connection events are not broadcast — Feishu delivers
  each event to one connection — so sharing a bot between instances sends approvals to a random side.
- **The client half is a single hand-written file** with no build step, rendering with basic React
  elements rather than the shared UI kit.
- **The published package is about 4 MB**, because it ships the Feishu transport and that transport's
  dependencies inside the tarball. That is exactly why installing compiles nothing.
- **Verified on a real Feishu tenant, but not for this version.** One-click app creation, the long
  connection, card delivery and card callbacks all ran against a real app. The callback field paths,
  option rows and free-text answers changed after that run: they are covered by tests, but still need one
  device confirmation ([ADR 0005](docs/decisions/0005-connected-means-connected.md)).

## Going further

| Doc | What is in it |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Every option, its default, and which ones the Settings card changes at runtime |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Install, binding, and cards that never arrive |
| [docs/decisions/](docs/decisions/) | Why the plugin is shaped this way — one record per decision |
| [docs/development.md](docs/development.md) | Test suite, real-assembly check, debugging a running deployment |
| [providers/README.md](providers/README.md) | The channel contract: what a transport other than Feishu must implement |
| [SECURITY.md](SECURITY.md) | The security invariants this plugin claims |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |

## License

[MIT](LICENSE)
