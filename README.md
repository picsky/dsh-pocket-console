# dsh-pocket-console

**Put [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) in your pocket.** When you step away from the desk, `dsh-pocket-console` forwards the two moments that would otherwise stall an agent — **tool-call approvals** and **`ask_user_question` prompts** — to your phone as Feishu interactive cards, so you can approve or answer from anywhere.

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

English · [简体中文](README.zh-CN.md)

> **Unofficial project.** Independently developed and maintained by community members — not affiliated with DeepSeek, and not reviewed or endorsed by it. Evaluate any third-party plugin before you install it.

---

## The problem

An unattended DeepSeek Harness run does not fail when it needs you — it **waits**. Neither seam has a timeout:

- A tool call that needs approval resolves only when an answerer replies, so the turn sits there.
- `ask_user_question` blocks exactly the same way.

Close the browser and walk away, and the agent is stuck until you come back. `dsh-pocket-console` is the answerer that reaches you.

## What it does

- **Desktop first.** Every request goes to the desktop GUI first. Answer there and your phone is never touched.
- **Phone as backup.** After `delaySeconds` with no desktop answer, the request goes out as a Feishu card. Tap a button and the agent continues immediately.
- **Covers both seams.** Approvals *and* questions, not just one.
- **A real DSH plugin, not a wrapper.** It ships as a `dsh.bundle` profile layer, registers on the two documented answerer waterfalls (`approval/request`, `user-questions/request`) with `prepend: true`, and contributes a Settings card on its own namespace. Nothing in DSH is patched or forked.
- **One-scan setup.** The Settings card shows a QR code. Scanning it creates the Feishu app, configures its permissions, event subscription, and callback, and records your recipient id — automatically.
- **Outbound only.** Delivery rides the Feishu WebSocket long connection, so there is no public IP, domain, port forwarding, or tunnel.
- **Channel-agnostic core.** Feishu is one transport behind a documented contract. Telegram, WeCom, DingTalk, or ntfy are a new file, not a rewrite.

<!-- Demo: record a short GIF of the Settings card → scan → approval arriving on the phone,
     save it as assets/demo.gif, then replace this comment with:
     <p align="center"><img src="assets/demo.gif" alt="Binding from the Settings card and approving from the phone" width="720"></p> -->

## Quick start

Install from [npm](https://www.npmjs.com/package/dsh-pocket-console). The published tarball carries its Feishu transport inside it, so the install resolves nothing that needs a build permission and runs no install-time script:

```sh
dsh plugin --profile web add dsh-pocket-console
```

A tarball from `pnpm pack` installs the same way:

```sh
dsh plugin --profile web add ./dsh-pocket-console-<version>.tgz
```

Installing straight from GitHub works too, but a git dependency resolves its own dependencies from the registry, so the transport's `protobufjs` postinstall makes pnpm ≥11 stop that first install. pnpm appends a stub to the profile's `pnpm-workspace.yaml`, and the stub is not a decision — set it to `false` and re-run:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  protobufjs: false
```

```sh
dsh plugin --profile web add github:picsky/dsh-pocket-console
```

Restart `dsh web`, then open **Settings → Plugins → Plugin configuration → "Pocket console"**:

1. Click **Start binding**
2. A QR code appears in the card
3. Scan it with Feishu (or open the same link on your phone)
4. The card flips to **Bound** and shows your recipient

That is the whole setup. The Feishu app, its permissions, its long connection, and your recipient id come from the official one-click app creation flow ([OAuth 2.0 Device Authorization Grant](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)); the link is valid for 10 minutes and can be used once.

To remove it:

```sh
dsh plugin --profile web remove dsh-pocket-console
```

## How it works

DSH resolves both of these through Cordis **waterfall events**, and the Web GUI is just one answerer on each chain:

```
approval/request          ─┐
                           ├─→ dsh-pocket-console ─→ channel ─→ your phone
user-questions/request    ─┘         │
                                     └─→ next() → desktop GUI → other answerers
```

Two design points carry the whole thing:

- **It registers with `prepend: true`.** The shipped Web forwarding listener does not call `next()` while a browser is connected, so an escalation answerer registered behind it would never run at all.
- **It calls `next()` first and races the timer.** The desktop chain keeps running unchanged; whichever side answers first wins. Approval semantics do not change — a grant is still one-shot (`allowed-once`).

The card edits the settings above through the client **settings scope**, so each write is fenced by the revision the card read, and a save is the only thing that writes. Binding and status talk to the Host half over **same-origin HTTP routes** (`/__pocket/state`, `/bind`, `/unbind`, `/qr.svg`) rather than a Remote method: the Remote type surface is generated and the forwarded-event allowlist is host-owned, so neither is open to out-of-tree plugins. Same-origin reuses the browser's existing session and needs no token. `/state` reports the enrollment, the effective settings, and every escalation still open — with what each one is and whether the phone already has it. Both the section and the routes follow their services through `ctx.inject` rather than reading them once at load, so a deployment that composes no settings provider installs no section, one that composes no web server logs the binding link instead of serving a card, and either way the plugin still loads and both halves appear whenever the service does.

## Answering questions from your phone

`ask_user_question` takes an **array** of questions and returns every answer at once. The desktop GUI walks them one at a time with a "2 / 3" counter; the phone card lays them all out at once — deliberately:

| | Desktop GUI | Phone card |
|---|---|---|
| Layout | One question at a time, with Back / Next | All questions visible, answer in any order |
| Options | A list, each with its description | One full-width button per option, descriptions in the body above |
| Typed answer | Available beside the options | Available beside the options, submitted with them |
| Answered | Gone once you page past it | **Stays in place**, shows `✅ your choice`, loses its controls |
| Submit | "Submit" appears on the last question only | Resolves automatically once every question is answered |

All-at-once suits a phone: each card rewrite is a network round trip, so a page-turning wizard turns "answer three questions" into three waits, and scrolling beats paging on a small screen. What it must not become is a card that does nothing when you tap, so **every answer rewrites the card** — the progress line advances, the answered question turns into `✅ answer`, and the rest stay live.

Question shapes:

- options, single-select → one full-width button per option, plus a typed answer for the same question
- options, multi-select → checkboxes plus an optional typed answer, submitted together
- no options → a free-text input plus a Submit button
- an option `description` renders as an **Options** legend in the body — a button label has no room for it

## Configuration

Every value has a default, so the plugin works with no configuration. To tune it, override the row in your own profile layer — a patch replaces the row's entire `config`, so restate every key you want to keep:

`$DSH_HOME/profiles/web/cordis.patch.yml`

```yaml
- id: pocket-console
  config:
    channel: dsh-pocket-console/providers/feishu.js
    channelConfig:
      domain: feishu          # or lark
      appName: Pocket console
      # receiveId: 'ou_xxx'   # optional: skip the scan and name a recipient
    delaySeconds: 600         # desktop head start; 0 = both sides live at once
    maxDetailChars: 1200
    titlePrefix: DSH
```

`delaySeconds`, `maxDetailChars`, and `titlePrefix` are also registered as a **settings namespace**, so they can be changed at runtime without a restart.

| Field | Default | Meaning |
|---|---|---|
| `channel` | `dsh-pocket-console/providers/feishu.js` | Transport module |
| `channelConfig` | `{}` | Transport-owned settings |
| `delaySeconds` | `120` | How long the desktop GUI answers alone |
| `maxDetailChars` | `1200` | Truncation bound for reasons and question detail |
| `titlePrefix` | `DSH` | Card title prefix |

Transport settings (`channelConfig`):

| Field | Default | Meaning |
|---|---|---|
| `appIdRef` | `DSH_FEISHU_APP_ID` | Credential reference name |
| `appSecretRef` | `DSH_FEISHU_APP_SECRET` | Credential reference name |
| `domain` | `feishu` | `feishu` or `lark` |
| `receiveId` | — | Name a recipient to skip the scan |
| `receiveIdType` | `open_id` | `open_id` / `chat_id` / `user_id` / `email` |
| `appName` / `appDesc` | see source | Prefilled app identity on the confirmation page |
| `createOnly` | `true` | Only ever create a new app, never overwrite an existing one |

## Security

An approval card is a **remote code-execution grant channel**. It is built accordingly.

- **Grants are one-shot.** `allowed-once` applies to exactly the call that asked, and nothing after it.
- **Secrets never touch the environment.** Every command the agent runs inherits the process environment and could read a secret out of it. Credentials live in `$DSH_HOME/.credentials.yaml` instead.
- **The app asks for the minimum.** It starts from the minimal preset (`addons.preset: false`, Bot capability only) and adds exactly three scopes, one event, and one callback — not the broad default template with Drive, Wiki, and Bitable access.
- **Callback payloads are validated.** Buttons carry a single-use random `rid`; an answer must name an option that question actually offered, and the `rid` dies the moment the request settles.
- **Mutating routes are same-origin only.** `/__pocket` deliberately sits outside the `/api` trust fence, so it carries its own `Origin` check and refuses cross-site writes with `403`.
- **Outbound only.** The long connection needs no inbound port, no public IP, and no tunnel.
- **Installing runs nothing.** The tarball ships its transport bundled rather than resolved, so a profile installs no dependency that declares an install script and executes none of them; the bundled code is the official SDK, exactly as it was published.

## Troubleshooting

**The first install from GitHub stops on `ERR_PNPM_IGNORED_BUILDS`.**
A git dependency resolves its own dependencies from the registry, so pnpm ≥11 meets `protobufjs`'s postinstall and refuses to finish until that script is allowed or declined. The stub pnpm appends is not a decision: set it to `false` in the profile's `pnpm-workspace.yaml` and re-run. Installing from npm never reaches this, because the transport arrives bundled.

**pnpm wrote `minimumReleaseAgeExclude` into the profile, or installed the previous version.**
Both are pnpm's supply-chain policy for a version published very recently, not something this plugin asks for. It holds a fresh version back, resolves an unpinned spec to the one before it, and records the exclusion that lets the one it did install through. Name the version to take it right away — `dsh plugin --profile web add dsh-pocket-console@0.1.1` — and re-add the plain name later if you would rather track releases automatically. pnpm also caches registry metadata, so a version published minutes ago can stay invisible until that cache refreshes.

**The Settings card does not appear.**
The card is keyed on the settings namespace the Host serves. Check the plugin loaded (`dsh --profile web --dump-config` should list a `# == dsh-pocket-console` layer), then reload the page — the served namespace list re-reads on a document commit or a reconnect, not on registration.

**"Start binding" fails, or no QR code appears.**
The one-click flow needs to reach `open.feishu.cn`. If the host is behind a proxy, make sure that host is reachable.

**The QR code appeared but scanning does not finish.**
The link is valid for 10 minutes and can be used once. Click **Retry** for a fresh one. Your Feishu account must be able to create apps in its organization; on a personal account with no organization, create a free organization first and invite yourself.

**The connection logs `ws client ready` but buttons do nothing.**
Feishu's older "message card callback" is not available over the long connection — only the newer `card.action.trigger`. Make sure the app subscribes to `card.action.trigger`; the one-click flow does this for you.

**A button answers with 该请求已处理或过期.**
The click carried no live request: the desktop answered that request first, or it was cancelled — a decision rewrites the card, so its buttons should have gone with it. Releases before 0.1.0 read card actions from the wrong envelope field and produced this toast for every click; upgrade if that is the version in the profile.

**Approvals never reach the phone.**
Confirm the card says **Bound**. Then check `delaySeconds` — it is the desktop's exclusive window, and the card is only sent after it elapses.

**Is it safe to run alongside another Feishu bot?**
Only if it is a **different app**. Feishu delivers long-connection events to one client at random, so two tools sharing one app silently drop each other's callbacks. Create a new app.

**Does it work with the Auto review preset?**
Not for approvals. Under Auto review, `approval/policy` is `never` and tool approvals no longer pass through `approval/request`, so there is nothing to escalate. Question escalation still works.

## Writing another channel

The core owns four things: the two answerer seams, the escalation timer, the pending registry, and decision decoding. **Everything about how a message travels and how a button comes back belongs to the channel.**

A channel is one ESM file exporting `create({ ctx, config, binding, log })` and returning a small object — `available`, `supportsForms`, `deliver`, `update`, `subscribe`, `close`, plus optional `enrollmentState` / `beginEnrollment` / `clearEnrollment` for scan-style onboarding.

See [`providers/README.md`](providers/README.md) for the full contract. Candidate transports:

| Channel | Outbound only | Can answer | Notes |
|---|---|---|---|
| Telegram Bot | ✅ long poll | ✅ inline keyboard | `deliver` sends, `subscribe` polls |
| WeCom / DingTalk | ✅ long connection | ✅ interactive cards | Structurally identical to the Feishu channel |
| ntfy | needs client reachability | ✅ action buttons | Buttons call a small route on the host |
| Bark / ServerChan | ✅ | ❌ push only | `supportsForms: false`, notification only |

## Limitations

- **A desktop panel does not disappear the instant the phone answers.** It clears when the tool call's cancellation signal arrives, usually right after the tool settles. The outcome is correct either way; a stale panel is the only artifact.
- **Card text is truncated** at `maxDetailChars`; a `plan-review` plan can be long.
- **Long connections are limited to 50 per app and are not broadcast** — do not run several DSH instances against one Feishu app.
- **The browser half has no build step**, so it is hand-written in the client module system's factory format and renders with plain React elements rather than the shared UI component library.
- **The published package is about 3.7 MB**, because it carries its Feishu transport — and that transport's own dependencies — inside the tarball. That is what keeps an install free of build permissions; nothing is compiled on the machine that installs it.
- **Verified against a live Feishu tenant, but not yet at this release.** The one-scan app creation, the long connection, card delivery, and card actions arriving back all work against a real app. The card-action field path, the one-option-per-row layout, and typed answers shipped after that pass: the suite covers them, and a phone still has to confirm them.

## Development

Plain ESM JavaScript, **no build step** — nothing here compiles, and the tests need no install. Publishing is the one operation that touches dependencies: the transport is bundled into the tarball (`bundleDependencies`), so `pnpm install` runs before `pnpm pack`/`pnpm publish`, and the consumer's profile then resolves nothing that needs a build permission. `prepack` refuses to build a tarball without the transport in it.

```sh
npm test
```

Nothing to install first: the suite replaces its four production dependencies through a Node module resolution hook (`test/hooks.mjs`), so it needs no credentials and no network.

23 cases cover: settings namespace and route registration, no escalation before binding, the unbound → awaiting → bound state machine, the QR route, cross-origin refusal, unbind cleanup, the unbind race against a late scan, delayed delivery, card contents, button round-trip, desktop-first suppression, multi-question accumulation and card rewrite, multi-select forms with and without a typed answer, free text, forged-option refusal, re-binding by direct message, the pending report, a deployment without the optional services and their later arrival, runtime settings changes, cancellation, disposal, failure degradation, and the browser half's load-and-register shape.

Debug with a local overlay by pointing `channel` at a relative path:

```yaml
- insert:
    - id: pocket-console
      name: ./index.js
      config:
        channel: ./providers/feishu.js
```

## License

[MIT](LICENSE)
