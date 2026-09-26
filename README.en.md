# dsh-pocket-console

**Step out — the task won't stall.**

You drop a task on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) before heading out, expecting to review the result when you get back — and it is stuck on the plan-confirmation question.

`dsh-pocket-console` exists for that: it keeps a stalled session moving while nobody is at the desk.

It turns the moments that need a person — **tool-call approvals**, **`ask_user_question` questions**, and a finished run's **result** — into Feishu cards on your phone once the desktop has had its chance to answer; one tap and the agent continues, and a reply from the phone enters the session as your own message; a finished shard can also **hand you the next task** to start from the phone. While the phone holds the person, the run's **live progress** shows on a card that is edited in place. The phone gets the decisions and the conversation's next step — never the machine: the desk, the session, the settings and the credentials stay where they are, and one outbound long connection is all it takes — no public IP, no domain, no tunnel.

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![CI](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml/badge.svg)](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

English · [简体中文](README.md)

---

## Install and uninstall

The published tarball carries its Feishu transport inside it, so the install resolves nothing that needs a build permission and runs no install-time script:

```sh
dsh plugin --profile web add dsh-pocket-console
```

Then restart `dsh web` and open **Settings → Plugins → Plugin configuration → Pocket console** (from DSH 0.1.7 the same card is in the sidebar's **Plugins** page, listed under that page's *Official* group; Settings keeps only the read-only plugin list):

1. Click **Scan to create an app**. If you already have one, click **Use an existing app** and enter its App ID and App Secret.
2. Scan the QR code with Feishu (the link is valid for 10 minutes and can be used once).
3. The card reports **Bound** and lists the **App**, the **Recipient** and the **Connection** (established / dropped, reconnecting…).

Credentials and the recipient live in the credentials store, so every later `dsh` start reconnects the long connection by itself — no settings visit, no second scan. **Use another app** switches apps; **Unbind** stops the phone side. Installing straight from GitHub needs one build script allowed through, which [troubleshooting](docs/troubleshooting.md) covers.

To remove it:

```sh
dsh plugin --profile web remove dsh-pocket-console
```

## Tuning it

It works out of the box: the Settings card exposes four settings and nothing else.

| Setting | Default | Meaning |
|---|---|---|
| Desktop head start (seconds) | `120` | The request goes to the phone only if the desktop has not answered by then. `0` sends it immediately |
| Title prefix | `DSH` | Prefix on every phone message title |
| Result notices | `When idle` | After a session stops, the turn result goes to the phone with a box you can reply in. Its send delay reuses the desktop head start above |
| Debug mode | `Off` | `On` writes the plugin's decision about every card to `$DSH_HOME/pocket-console-debug.log` — why a card was sent, edited, or skipped |

Every row can be **Reset**. **How an edit lands depends on the Host**: where the Host renders the form itself (DSH 0.1.7 on) each change **takes effect at once** and the card has no Save; on the older contract the card marks it **Unsaved** until **Save**. A write that fails is said on the card either way.

**Anything the card does not show belongs to the deployment.** The channel, the interface language, the mirror lifetime and the like stay out of the card and are overridden in the profile layer — a patch replaces the row's entire `config`, so restate every key you want to keep:

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
    debug: off
```

That is every key at the value the code already ships, so copying it changes nothing. [Every setting](docs/configuration.md) documents the rest.

## Security

An approval card is a **remote code-execution authorization channel**, so it is built like one:

- **Grants are single-use.** `allowed-once` applies to that call only; the random id that carries it dies the moment the request settles.
- **The blast radius of a lost phone is one answer — or one task.** The card is itself a credential, so only the bound recipient can press: a private chat only binds an unbound deployment, and group messages never bind. Answering a card decides something the desk already started. **Starting a new task from the phone is larger than that**: it begins work in the current session's workspace, so a lost phone is a way to run a turn in that project, within whatever the agent's own approval rules allow. It still cannot choose a workspace, reach another project, or touch settings and credentials.
- **Secrets never go in environment variables.** Every command the agent runs inherits the process environment, so credentials live in `$DSH_HOME/.credentials.yaml`.
- **The app asks for the minimum.** Three permissions, one event and one callback, from the minimum base rather than the default template's cloud-doc permissions.
- **There is no server of ours in the path.** Feishu sees the card, because Feishu is the transport.

Full invariants, threat model and reporting: [SECURITY.md](SECURITY.md).

## What it deliberately does not do

- **No GUI mirroring.** Moving the interface would move the workspace, the session, the settings and the credentials — so you also **cannot browse sessions, read history, or change settings from the phone**. What you *can* do is start the next task: when a run finishes while the phone holds you, **the result card itself carries** the form that opens a new session in that same workspace — no second card, and no second notification. And when you reply on that card, **it becomes the run your reply starts**: the card that moves is always the one you pressed.
- **No push to the phone by default.** A card goes out only when the desktop has not answered in time — with two deliberate exceptions, because both are somebody being **blocked**, not a status update: an approval or question, and the result of a finished run.
- **No auto-approval, ever.** The plugin never decides in your place: **silence never approves**.
- **No inbound listener.** No port, tunnel, relay or third-party server — so also no "reachable from anywhere".
- **No changes to DSH.** It ships as a `dsh.bundle` profile layer and registers on two documented waterfalls. Nothing in the harness is patched or forked, and a DSH upgrade cannot break it.

## How it breaks

These are honest gaps, not choices.

- **Mirroring to the desktop needs the page open.** After a phone answer, the open page settles the way a click there would; with no page open the answer still reaches the model and the session log, but a page opened later will not replay it — the mirror is valid for one minute.
- **One Feishu app serves one DSH instance.** Long-connection events are not broadcast, so two instances sharing one bot send approvals to a random side.
- **A press during the restart window does not take.** Approvals and questions live in memory, and a restart clears them. A button pressed while the process was down is not replayed; a press on an old card after the restart answers "request ended" and the card is rewritten as finished — the card is still there, but that decision is gone. Result cards are unaffected: they go through the durable store and still take a reply after a restart.
- **Card text is limited by bytes, not characters.** The documented cap is 30 KB, and **that figure is wrong**: measured against a real tenant, this plugin's own app accepted a **131 KB** request body and was refused at 164 KB. What the body carries is also not the text's own size — the text is escaped into the card JSON and the card JSON is escaped again, so a quote or a backslash costs more each time. Text is therefore held under **32 KB as the request will count it**, which is measured rather than copied, and it is truncated explicitly when it does not fit. That is roughly **11,000 Chinese characters** at the measured rate (a 60-step plan costs about 3 KB), so a long plan arrives whole rather than as a fragment.

## Which of these is this?

| | Transports | Phone gets | You must operate | Fits |
|---|---|---|---|---|
| **Desktop GUI mirroring** — [dsh-pocket](https://github.com/shaobeichen/dsh-pocket), [ds-harness-remote](https://github.com/liguobao/ds-harness-remote), [dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) | the whole Web GUI over LAN, tunnel, P2P or hosted relay | the full interface: workspaces, sessions, settings, credentials | a tunnel, a relay, a domain, or trust in someone's relay | working away from the computer |
| **IM console** — [dsh-im](https://github.com/xmanrui/dsh-im), [dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot) | chat platform long connections | sessions, workspaces, models, permissions; several channels | a bot app, often a developer-console walkthrough | driving the agent from chat |
| **Notification only** — [dsh-turn-notify](https://www.npmjs.com/package/dsh-turn-notify), [@dsh-suite/plugin-notify](https://www.npmjs.com/package/@dsh-suite/plugin-notify) | toast, browser, webhook, Bark, ServerChan | a message it cannot answer | per-channel webhook or key | knowing when something happened |
| **dsh-pocket-console** | one outbound WebSocket | the **decisions and the next step**: single-use approvals, questions, a result to reply to, the next task; live progress while it runs | nothing | an agent that must not stall while you are away from the desk |

If you want the computer in your hand, install one of the first three. This plugin is for the other case: **the computer stays where it is, and only the decisions — and the conversation's next step — travel.**

## Supported DSH versions

A plugin is verified against a *harness*, not against DSH in general. This one supports **two at
a time**: the oldest it was written for, and the newest that exists when a release is cut.

| DSH | What is verified on it |
|---|---|
| `0.1.6-alpha.1` | the whole pipeline: the installed settings section and the keyed settings card (Settings → Plugins → Plugin configuration) |
| `0.1.7-rc.2` | the whole pipeline: the entry's own volatile `Config` and the sidebar's **Plugins** page |

Both legs run on every pull request (`ci.yml`'s `real composition` matrix), and again before a
release against **the tarball about to be published**: it is installed into a throwaway profile,
the real `dsh web` is booted, its own routes are read, the boot manifest is checked for this
plugin's entry, and the client bundle the shell would serve is compared with the one the tarball
installed.

The window moves only at a release: when a new DSH version appears, a release may add a leg and
drop the oldest, and the release notes say so. A harness outside the window may well work —
nothing here claims it does.

**Versioning**: a version number is a *batch* of changes verified together, not one fix per
release. A version with a prerelease suffix (`0.9.6-rc.1`) publishes to npm's `next` channel
only, and is promoted to `latest` by hand — `npm dist-tag add` — after a person has run it. So
`latest` only ever points at a version someone has actually used. The full rules are in
[docs/releasing.md](docs/releasing.md) and [decision 0030](docs/decisions/0030-a-release-is-a-batch-a-person-ran.md).

## For developers

- **Shape**: a `dsh.bundle` profile layer, plain ESM, **no build step**; the published package is about 4 MB because the Feishu transport and its dependencies are bundled inside the tarball.
- **Tests**: `npm test`. No install, no network and no credentials — the production dependencies are replaced by in-repo stubs.
- **Gates**: `npm run check:parity` (one setting has to agree in six places) and `npm run e2e` (packs the working tree and proves the artifact activates and boots its browser half in a real `dsh web`). CI runs `verify` on two Node versions, `real composition` on every harness in the support window against the tarball, and `publish payload`.
- **Before changing something**: [docs/decisions/](docs/decisions/) records why it is shaped this way; [docs/development.md](docs/development.md) covers the suite and debugging.
- **How a change lands**: [CONTRIBUTING.md](CONTRIBUTING.md); what changed when is in [CHANGELOG.md](CHANGELOG.md). Writing a transport other than Feishu: [the channel contract](providers/README.md).

## Going further

| Doc | What is in it |
|---|---|
| [Configuration](docs/configuration.md) | Every option, its default, and which ones the Settings card changes at runtime |
| [Troubleshooting](docs/troubleshooting.md) | Install, binding, and cards that never arrive |
| [docs/decisions/](docs/decisions/) | Why the plugin is shaped this way — one record per decision |
| [SECURITY.md](SECURITY.md) | The security invariants this plugin claims |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How a change lands: issue, branch, pull request, the four checks |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |

## License

[MIT](LICENSE)
