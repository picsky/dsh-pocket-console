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

1. Click **Scan to create an app**, or **Bind an existing app**
2. A QR code appears in the card
3. Scan it with Feishu (or open the same link on your phone)
4. The card flips to **Bound** and shows your recipient

**Creating** walks the official one-click flow and registers everything the plugin needs on a brand-new app.

**Binding an existing app** asks for that app's **App ID and App Secret** (developer console → *Credentials & Basic Info*) and connects with them. There is no scan, no launch page, and no device-authorization wait: those two values are exactly what the channel needs, and they are stored in the credential store the same way the one-click flow stores its own. Nothing about that app is modified.

The launch page's own "update an existing app" mode is deliberately not used: it needs the same secret anyway, and it adds a polling flow and a ten-minute window in exchange for nothing.

**Without any scan**, put the app's credentials in the credential store under the names `DSH_FEISHU_APP_ID` and `DSH_FEISHU_APP_SECRET` (that is what `appIdRef` and `appSecretRef` point at), and the plugin connects on its own at every start. The recipient then comes from `receiveId`, or from you sending the bot any message — a direct message binds its sender.

Once the credentials are in, the recipient is all that is left: set `receiveId`, or send the bot any direct message and its sender becomes the recipient.

**One Feishu app serves one DSH instance.** Long-connection events are not broadcast: Feishu delivers each event to a single connection, so two instances sharing a bot would see approvals land on whichever one happened to receive them. Use one app per instance, and `titlePrefix` to tell them apart.

The app's permissions, its long connection, and your recipient id come from the official one-click app creation flow ([OAuth 2.0 Device Authorization Grant](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)); the link is valid for 10 minutes and can be used once.

**You scan once.** The app credentials and the bound recipient live in the credential store, so every later `dsh` start reconnects the long connection on its own — no card, no click. The scan is offered again only after **Unbind**, or from **Rebind**.

Releases are tag-driven and publish through npm trusted publishing; [docs/releasing.md](docs/releasing.md) covers the one-time npm setup and what a release verifies.

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

The desktop follows. An answer given on the phone is mirrored onto the page's own composer, through the same client call a click there makes, so the request settles and the composer clears instead of waiting for a decision that already happened. The mirror also covers approvals. It is a browser-side action because the Host cannot withdraw a forwarded request: the gateway finishes one only when a browser answers it. The browser half reports each attempt — `loaded`, `watching`, `applied`, or `skipped` with its reason — and the Host logs it and serves the last few on its state route, so a mirror that is not landing says which step it reached.

## Result notices

Approvals and questions are requests: the harness is waiting, and so is the channel. A result notice is the other direction — a session you left running stops, and its result comes to the phone.

Set `resultNotify: idle` and, after a session goes quiet, the phone receives a card carrying that turn's **answer** plus a text box. Type the next instruction there and send it: it is delivered to the same session as a new message, and the work continues with the same context. No desktop is involved, and nothing waits on the desktop, so this path cannot strand a card the way a request can.

The answer is the message the Web GUI leaves unfolded — the turn's last assistant message that speaks without calling a tool. Everything else in the turn is process the GUI folds away, and a notice never carries it.

What suppresses or delays a notice:

- `resultNotify` is `off` by default.
- A session that produced no answer (only tool calls) notifies nothing.
- The notice waits out `delaySeconds` of quiet, and keeps waiting while the session is still working, so a run of turns collapses into one notice.
- One session notifies at most once per `resultNotifyCooldownSeconds`.
- Delegated sessions are not reported separately; the session that asked for the subagent is.
- A session whose agent the host has already reclaimed is not resumed, and says so in the log.
- A notice stops accepting a reply the moment it stops being the session's latest word: a newer result supersedes it, or new input arrives from any surface. There is no time limit — a notice you come back to tomorrow is still an offer. The card is rewritten to say why it stopped, so a reply can never inject an instruction written against a superseded answer.

The instruction enters the session as **your message**, attributed the way the harness attributes human input: the surface a person is speaking through mints it, which is what dsh's own remote client does with an editor prompt (`packages/acp/acp/src/session.ts`). That attribution is also what keeps the instruction visible in the Web flow: anything else is rendered as injected context, folded into the turn's process. It therefore carries human authority too — a feature that requires human input accepts it — and the log does not distinguish it from a message typed at the desk.

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
    resultNotify: idle        # off (default) or idle
    resultNotifyCooldownSeconds: 600
```

Three settings are the **settings namespace**, changeable at runtime from the Settings card without a restart: `delaySeconds`, `titlePrefix`, and `resultNotify`. The rest of the table is deployment-level: they exist so a deployment can retune the transport, and a person never has to read about them. The phone card follows the interface language through `messages.js`; `locale` is the fallback for a deployment that never opens the Web UI.

| Field | Default | Meaning |
|---|---|---|
| `channel` | `dsh-pocket-console/providers/feishu.js` | Transport module |
| `channelConfig` | `{}` | Transport-owned settings |
| `delaySeconds` | `120` | How long the desktop GUI answers alone |
| `titlePrefix` | `DSH` | Card title prefix |
| `resultNotify` | `off` | `idle` sends each stopped session's result to the phone |
| `resultNotifyCooldownSeconds` | `600` | Shortest gap between two result notices for one session |
| `mirrorTtlSeconds` | `60` | How long a phone decision may still close the desktop composer |
| `locale` | `zh` | Language of the cards sent to the phone (`zh` or `en`) |

Transport settings (`channelConfig`):

| Field | Default | Meaning |
|---|---|---|
| `appIdRef` | `DSH_FEISHU_APP_ID` | Credential reference name |
| `appSecretRef` | `DSH_FEISHU_APP_SECRET` | Credential reference name |
| `domain` | `feishu` | `feishu` or `lark` |
| `receiveId` | — | Name a recipient to skip the scan |
| `receiveIdType` | `open_id` | `open_id` / `chat_id` / `user_id` / `email` |
| `appName` / `appDesc` | see source | Prefilled app identity on the confirmation page |
| `createOnly` | `true` | Keep the one-click flow to creating a new app; an existing one is bound with its own credentials |

## Security

An approval card is a **remote code-execution grant channel**. It is built accordingly.

- **Grants are one-shot.** `allowed-once` applies to exactly the call that asked, and nothing after it.
- **Secrets never touch the environment.** Every command the agent runs inherits the process environment and could read a secret out of it. Credentials live in `$DSH_HOME/.credentials.yaml` instead.
- **The app asks for the minimum.** It starts from the minimal preset (`addons.preset: false`, Bot capability only) and adds exactly three scopes, one event, and one callback — not the broad default template with Drive, Wiki, and Bitable access.
- **Callback payloads are validated.** Buttons carry a single-use random `rid`; an answer must name an option that question actually offered, and the `rid` dies the moment the request settles.
- **Only the bound recipient can press.** A card is a capability — whoever holds the message can press its buttons — so an action is honored only when the operator's `open_id` is the bound recipient. An answer from the phone becomes human-attributed input, which is exactly why that check is not optional.
- **Every route is behind the connection's trust fence.** `/__pocket` carries the binding, the open requests, and the mirror decision, so a request is answered only when the connection accepts it (the same fence the `/api` surface uses); an untrusted caller gets its `401`/`403` before anything is read. A deployment without a connection falls back to the `Origin` check on every mutating call, which refuses cross-site writes with `403`.
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

- **A phone answer needs an open desktop page to be mirrored there.** The browser half reads the pending interaction the page already has and applies the phone's answer to it, so the composer settles exactly as a click would. With no page open there is nothing to mirror — the answer still reaches the model, and the transcript shows it — but a page reloaded later never replays it, because a mirror is only honoured for a minute.
- **Card text is bounded in bytes**, not characters: a card message may not exceed Feishu's 30 KB body limit, and a Chinese character costs three bytes, so the plugin keeps text under 9 KB (about 3000 characters) and says when it clipped. A `plan-review` plan longer than that arrives as its head, with the decision buttons still usable.
- **A result notice does not revive a reclaimed session.** If the host has already let the agent go, the notice is skipped and logged instead of resuming the session.
- **Long connections are limited to 50 per app and are not broadcast** — do not run several DSH instances against one Feishu app.
- **The browser half has no build step**, so it is hand-written in the client module system's factory format and renders with plain React elements rather than the shared UI component library.
- **The published package is about 4 MB**, because it carries its Feishu transport — and that transport's own dependencies — inside the tarball. That is what keeps an install free of build permissions; nothing is compiled on the machine that installs it.
- **Verified against a live Feishu tenant, but not yet at this release.** The one-scan app creation, the long connection, card delivery, and card actions arriving back all work against a real app. The card-action field path, the one-option-per-row layout, and typed answers shipped after that pass: the suite covers them, and a phone still has to confirm them.

## Development

Plain ESM JavaScript, **no build step** — nothing here compiles, and the tests need no install. Publishing is the one operation that touches dependencies: the transport and the QR encoder are bundled into the tarball (`bundleDependencies`), so `pnpm install` runs before `pnpm pack`/`pnpm publish`, and the consumer's profile then resolves nothing that needs a build permission. `prepack` refuses to build a tarball without the transport in it.

```sh
npm test
```

Nothing to install first: the suite replaces its five production dependencies through a Node module resolution hook (`test/hooks.mjs`), so it needs no credentials and no network. The same command also runs `npm run e2e`, which installs the packed tarball into a scratch profile and boots the real `dsh web` to prove the plugin activates — that one needs the `dsh` release named in CONTRIBUTING. Cases live under `tests/`, one file per domain — `settings`, `binding`, `escalation`, `questions`, `notices`, and `client` — over the shared harness in `tests/support/harness.mjs`.

39 cases cover: settings namespace and route registration, no escalation before binding, the unbound → awaiting → bound state machine, the QR route, cross-origin refusal, unbind cleanup, the unbind race against a late scan, delayed delivery, card contents, button round-trip, desktop-first suppression, multi-question accumulation and card rewrite, multi-select forms with and without a typed answer, free text, forged-option refusal, re-binding by direct message, the pending report, a deployment without the optional services and their later arrival, runtime settings changes, cancellation, disposal, failure degradation, result-notice delivery and its single-use instruction round trip, result-notice suppression while off or busy or delegated, the notice cooldown, a notice refusing a reply once it is superseded or once the session has new input, a late reply still being accepted, a restart reconnecting from stored credentials without onboarding, the phone card following the interface language, a long detail and a long result clipped to the byte budget, a card the platform refuses for size retried smaller, mirror reports reaching the state route without the log, the panel transitions of one session beside another, and the browser half rendering every label with its own control and pointing its chevron up when open.

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
