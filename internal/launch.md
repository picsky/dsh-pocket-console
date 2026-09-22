# Launch plan

How this repository gets found. Internal — deliberately **not** in `package.json`'s
`files`, so it is not shipped to installers. `npm run check:parity` refuses a *published*
document that links in here, which is what keeps that true.

Everything here is written to be executed, not admired. The one hard blocker is §1.

---

## 0. Who owns the README's visuals

More than one workstream has edited these files, so the boundary is written down before
it costs a lost edit:

- **`assets/` owns the visuals** — which image goes where, how each is captured, and the
  insertion snippets. `assets/README.md` is the specification; `assets/demo-storyboard.md`
  is the frame-by-frame sheet. Read both before adding an image to either README.
- **This file owns the release and the announcement**, and does not add images.
- **The READMEs' prose, structure, and gates** are not the visuals workstream's concern.

What exists today, so nobody rebuilds it:

| Asset | State | Blocks |
|---|---|---|
| `demo-storyboard.md` | The frame-by-frame recording plan | Nothing — it is instructions, not an asset |
| `demo.gif` | **Does not exist** | §1, and the launch |
| The stills (`hero-pairing.png`, `settings-card.png`, `phone-questions.png`, `phone-result.png`) | **Do not exist** | Nothing yet; §1 of the asset spec ranks them |

Five hand-drawn SVGs stood in for those stills and **were removed**. They were pictures of
a screen rather than the screen, which is the one thing a `4 MB` plugin with a real UI does
not need: a capture cannot drift from the product, and it is not a second artefact to keep
in step. `assets/README.md` now describes captures only.

**Nothing is wired into either README yet**, and that is deliberate rather than forgotten:
the insertion point is a commented block with the absolute url already in place, so it is
correct the day the capture exists.

**A trap that is now closed.** `assets/` is not in `package.json`'s `files`, on
purpose — a 4 MB package does not need 3 MB of GIF. But the README is rendered on
**npmjs.com** as well as GitHub, and npm re-hosts only what the tarball carries, so a
relative `assets/…` path renders on GitHub and **404s on the package page**. This is
settled: every image in a root README uses
`https://raw.githubusercontent.com/picsky/dsh-pocket-console/main/assets/<file>`, which
GitHub renders identically — one form, both surfaces, nothing to keep in step.
`npm run check:parity` enforces it, including inside the commented insertion point, so
the block is already correct the day it is uncommented. `assets/README.md` §6 has the
detail.

---

## 1. The blocker: a demo GIF

`README.md` has carried a placeholder comment for this since before the first release.
Four independent audits reached the same conclusion, so treat it as the only P0:

> the whole pitch is "a card arrives on your phone", and there is currently no image of
> it anywhere in the repository.

**A recording plan already exists** — `assets/demo-storyboard.md` is frame-by-frame, with
crop regions, cursor actions, and the ffmpeg palette commands. Its five-shot summary is in
`assets/README.md` §3. Record from those; this file does not restate them.

The one thing to keep in mind while recording: **the shot that sells this is the desktop
settling by itself after the phone answers.** Without it the GIF reads as "a notification
arrived", which every notification plugin already does. With it, it reads as the desktop
and the phone being one conversation.

**Then wire it in.** `assets/README.md` §9 has the exact snippet; it goes in the commented
block under **What it does**, in both READMEs. Resolve the npm path question in §0 first,
so the image renders on GitHub *and* on npmjs.com.

**Social preview:** 1280×640 PNG, uploaded at repository Settings → Social preview. It
is the thumbnail on every share, in every chat client, for the life of the project.
Use the phone card, not a logo.

---

## 2. Repository metadata (do this before the GIF is even finished)

**Description** (make the entity searchable first; this is what GitHub and npm show):

```
Don't hand over the whole machine, just the decisions and the next step: DeepSeek Harness approvals, ask_user_question prompts and result replies reach your phone as Feishu cards, desktop first, outbound only — with live run progress and the next task one tap away.
```

**Topics.** `dsh-plugin` is the one that matters: there is no official registry, and
several marketplace projects scrape that GitHub topic daily. Without it, nothing below
finds this repository.

```
dsh-plugin  deepseek-harness  dsh  cordis-plugin  human-in-the-loop  approval
remote-approval  feishu  lark  chatops  mobile  agent  ask-user-question
```

Do **not** add `claude-code` or `cursor`. Unrelated high-traffic tags are what gets a
repository classified as tag-leeching and filtered out of the auto-curated lists.

**Also:** enable Issues (bug template already ships), confirm the CI badge is green on
`main`, and check that the About box links the npm package.

---

## 3. Publishing, in order

**0.9.0 is published, which discharges the warning this section used to carry.** The tree's
unreleased fixes are now what a new installer gets. Until that release, the published 0.8.1 was
**not** what a new installer wanted: it could strand a request, and its binding could be taken
over by any account that could message the bot. (0.8.2 and 0.8.3 were numbered in the tree and
never published — the registry's `latest` stood at 0.8.1 the whole time.)

**Verified before the first tag**, so these are not things to re-discover during a
release:

| Check | Result |
|---|---|
| `npm run check:parity` | passes — names, defaults, published links, wired visuals |
| `npm test` | 275/275, no network and no credentials |
| `npm pack --dry-run` | docs present, `internal/` and `assets/` absent, transport bundled |
| Action pins (`actions/checkout@v6`, `actions/setup-node@v6`, `pnpm/action-setup@v6`) | all three tags exist |
| CI matrix vs `engines` | `[22, 24]` against `^22.19.0 \|\| >=24.0.0` — consistent |
| Release path | `prepack` → `verify-pack.mjs` runs during `npm publish`, so a tarball that lost its bundled transport cannot ship |

```sh
npm run check:parity
npm test
# the version bump and the changelog land as a pull request now (`internal/maintaining.md` §3):
git switch -c release/0.9.0
npm version minor --no-git-tag-version
# open the PR as "Release 0.9.0", merge it once the four checks are green, then:
git fetch origin && git switch main && git pull --ff-only
git tag -a v0.9.0 -m "Release 0.9.0" && git push origin v0.9.0
```

Then confirm the release ran (`release.yml` publishes on a `v*` tag through npm's
trusted publishing) and the tarball carries its docs:

```sh
npm pack --dry-run
```

---

## 4. Channel order

Fire these in sequence, not on one day. Each wave produces install bugs; the next wave
should not arrive until they are fixed, because a broken install on a high-traffic day
is unrecoverable.

### Wave 1 — the launch post (day 1)

**Official DSH Discussions → "Show and tell".** This is where plugin launches actually
happen and where the audience already runs DSH daily. Read the pinned community post
first.

Title:

```
DSH | dsh-pocket-console | 桌面优先的飞书审批/提问卡——人不在，决策也不卡
```

Body: the problem in two sentences, the GIF, the one-line install, then — honestly —
what makes this one different from the other Feishu bridges: approvals, questions,
result replies, the next task from the phone, live run progress — in that order —
plus desktop-first with a configurable head start and desktop mirroring, three scopes
instead of a broad template, and a real-composition e2e job in CI for an alpha that
ships weekly. Disclose "unofficial" and repeat the README's caveats rather than
smoothing them out.

### Wave 2 — registries and lists (days 1–7)

Open PRs against the curated lists that accept them. Write a real description per
repository; the auto-curated ones filter for keyword stuffing, and one of them states it
explicitly removes tag-leechers.

- `dshworks/awesome-dsh-plugins`
- `awesome-dsh-plugin/awesome-dsh-plugin`
- `dngr2/awesome-dsh-plugin`
- `AdamPlatin123/awesome-dsh-plugins`
- `Dominic789654/awesome-deepseek-harness`
- `Sakana-yuyu/dsh-plugins`
- `vlln/plugin-registry`

PR title shape:

```
Add picsky/dsh-pocket-console (approval) — Feishu approval/question escalation, desktop-first
```

Several of these refresh star counts on a schedule, so a listing keeps re-advertising.

### Wave 3 — Chinese communities (week 2)

Wait until a few stars and a listing exist; these audiences read social proof.

| Where | Title | Note |
|---|---|---|
| LINUX DO, 开源推广 tag | `【开源推广】给 DeepSeek Harness 做了个「口袋控制台」：飞书卡片一键批准工具调用，桌面优先、手机兜底` | The tag exists for exactly this. Read its rules. |
| V2EX, 分享创造 | `[分享创造] DSH 口袋控制台：把工具调用审批和 ask_user_question 推到飞书，人在外面也能批` | **A V2EX account must be ≥30 days old to post here.** Check now. |
| 掘金 / 知乎 / 少数派 | Pitch, don't post | Editors are actively publishing "top N DSH plugins" listicles and are looking for entries. Send three lines, the GIF, the install command. |

Post in Chinese, in your own words. A copy-pasted English blurb is what gets removed.

### Wave 4 — English generalists (week 3)

**Show HN**, weekday, US morning:

```
Show HN: DSH Pocket Console – Approve your coding agent's tool calls from Feishu on your phone
```

Expect "why not Telegram/Slack?" — answer with the desktop-first head start, the
optional channel contract, and no public IP. Follow the Show HN guidelines; never ask
for upvotes.

**Reddit** (r/LocalLLaMA, r/ClaudeAI, r/LLMDevs): weakest fit of the set, strictest
self-promotion rules, real ban risk. Only after everything above, and only as a
genuine contribution to a relevant thread.

**Product Hunt:** skip. Wrong audience for a DSH-specific plugin.

---

## 4b. Copy-paste bodies

Everything above is *what* to post and why. This is the *text*, so the launch can be
executed without composing anything. Edit for voice, but keep two things intact in every
version: the **unofficial** disclosure, and the **verification caveat** (the one-scan
flow, long connection, card delivery, and card actions were verified against a live
tenant; the card-action field path, one-option-per-row layout, and typed answers shipped
after that pass and still need a phone to confirm).

Every claim below is checkable in this repository — 3 scopes, 1 event, 1 callback;
nothing is patched in DSH; secrets live in the credential store rather than the process
environment.

### A. Official DSH Discussions → Show and tell

**Title**

```
[Show and tell] dsh-pocket-console — approve tool calls and answer ask_user_question from your phone (Feishu cards, desktop first, one-scan setup)
```

**Body**

````markdown
An unattended DSH run does not fail when it needs you — it waits. Neither
`approval/request` nor `user-questions/request` has a timeout, so if you close the
browser and walk away, the turn sits there until you come back.

**dsh-pocket-console** is an answerer that reaches your phone. Requests still go to the
desktop GUI first; after `delaySeconds` (default 120) with no answer, the request goes
out as a Feishu interactive card, and tapping a button continues the run immediately.

![binding and approving from the phone](https://raw.githubusercontent.com/picsky/dsh-pocket-console/main/assets/demo.gif)

```sh
dsh plugin --profile web add dsh-pocket-console
```

**What it does that is less usual**

- **Approvals.** A tool call that needs the go-ahead arrives as a card; one tap approves
  (single-use, `allowed-once`) or rejects.
- **Questions, not only approvals.** `ask_user_question` returns every answer at once, so
  the card lays all the questions out with progress, multi-select, and a typed answer
  beside the options, rather than turning "answer three questions" into three waits.
- **The result comes back, with a box to reply in.** With `resultNotify: idle`, a session
  that goes quiet sends its answer with a reply box; what you type continues that session
  as your own message.
- **The next task, from the phone.** A finished run can hand you the next step: the
  result card carries a form that starts a new session in the same workspace.
- **The run, live.** While the phone holds the person, the run's progress shows on a card
  that is edited in place — status, turn and step, the tool it is waiting on.
- **Desktop first, and the desktop follows.** The phone is the fallback, not the default;
  a card only goes out after the desktop has had `delaySeconds` with no answer. When you
  do answer on the phone, the page you left open settles the same way a click there
  would — the composer closes instead of waiting on a decision that already happened.
- **Engineering, not a wrapper.** It is a `dsh.bundle` profile layer registering on the
  two documented answerer waterfalls with `prepend: true` — nothing in DSH is patched or
  forked. The channel contract is documented, so a transport that is not Feishu is a new
  file rather than a rewrite.
- **Least privilege, outbound only.** The one-click scan configures exactly three scopes,
  one event, and one callback on the minimal app preset. Delivery rides the long
  connection, so there is no public IP, domain, port forwarding, or tunnel. Credentials
  live in the credential store, never in the process environment.

**Setup is one scan.** The Settings card shows a QR code; scanning it creates the app,
configures its permissions, event subscription and callback, and records your recipient.
You can also paste an App ID and App Secret for an app you already have, which is checked
against the platform before anything connects.

**What is not verified yet.** The one-scan flow, the long connection, card delivery, and
card actions arriving back were verified against a live tenant. The card-action field
path, the one-option-per-row layout, and typed answers shipped after that pass — the
suite covers them (275 cases, no network needed), and a phone still has to confirm them.
Both branches of the credential check were observed live.

This is an **unofficial** community plugin, not affiliated with or endorsed by DeepSeek.
MIT. [README](https://github.com/picsky/dsh-pocket-console) ·
[npm](https://www.npmjs.com/package/dsh-pocket-console)

Questions and bug reports are welcome — especially from anyone running it against a
different tenant.
````

### B. Awesome-list / registry PR

**Title**

```
Add picsky/dsh-pocket-console (approval) — Feishu approval and question escalation, desktop-first
```

**Body**

```markdown
**dsh-pocket-console** forwards what stalls an unattended run — `approval/request`
and `user-questions/request` — and what comes after it, to a phone as Feishu
interactive cards, desktop first.

- **Approvals:** one tap approves (single-use) or rejects; the desktop answers first,
  the phone is reached after `delaySeconds` with no answer, and a phone answer is
  mirrored onto the open page's composer.
- **Questions:** answered all-at-once, with multi-select and typed answers, not only
  approvals.
- **Results you can reply to:** a stopped session's answer arrives with a box to reply
  in, and the reply continues the session as your own message.
- **Next task:** a finished run can start the next session from the phone, in the same
  workspace.
- **Live progress:** while the phone holds the person, the run's status, turn and step
  show on a card that is edited in place.
- **One-scan setup:** the Settings card's QR code creates and configures the Feishu app;
  three scopes, one event, one callback.
- **Outbound only:** the long connection needs no public IP or tunnel.
- **A real DSH plugin:** registers on the documented waterfalls with `prepend: true` and
  patches nothing. 28 decision records, 275 tests, and a real-composition e2e job in CI.

Install: `dsh plugin --profile web add dsh-pocket-console`

Unofficial community plugin, MIT.
https://github.com/picsky/dsh-pocket-console
```

### C. LINUX DO — 开源推广 tag

**标题**

```
【开源推广】给 DeepSeek Harness 做了个「口袋控制台」：飞书卡片一键批准工具调用，桌面优先、手机兜底
```

**正文**

````markdown
DSH 无人值守跑着的时候，最尴尬的不是报错，而是**它在等你**。
`approval/request` 和 `user-questions/request` 都没有超时：你关掉浏览器走开，
这一轮就停在那里，直到你回来。

**dsh-pocket-console** 就是一个能找得到你的 answerer。请求仍然先给桌面 GUI；
`delaySeconds`（默认 120 秒）内没人答，才以飞书交互卡片发到手机，点一下按钮，
Agent 立刻继续。

![绑定与在手机上审批](https://raw.githubusercontent.com/picsky/dsh-pocket-console/main/assets/demo.gif)

```sh
dsh plugin --profile web add dsh-pocket-console
```

**几个不太一样的点**

- **审批。** 需要拍板的工具调用以卡片送达，点一下批准（一次性，`allowed-once`）或拒绝。
- **提问，不只审批。** `ask_user_question` 一次收一组问题、一次返回全部答案，
  所以卡片把题目全部铺开，带进度、多选，以及选项旁边的输入框，
  而不是把"回答三个问题"在小屏幕上变成三次等待。
- **结果带着回复框回来。** 打开 `resultNotify: idle`，会话安静下来后
  会把结果连同一个输入框发给你，你写的内容会作为**你自己的消息**接着这个会话跑。
- **下一段任务，从手机开。** 跑完的一段会在结果卡上带一个表单，
  在同一个工作区里开一个新会话，不需要另一张卡。
- **执行过程实时可见。** 手机持有时，run 的状态、回合、步骤、正在等的工具
  都在一张原地更新的卡上。
- **桌面优先，而且桌面会跟着走。** 手机是兜底，不是默认。你在手机上答完之后，
  留在那儿的页面会用和"在桌面上点一下"完全相同的方式结算——面板关掉，
  而不是继续等一个已经做过的决定。
- **是真正的 DSH 插件，不是外壳。** 以 `dsh.bundle` profile 层分发，
  在两条有文档的 answerer waterfall 上以 `prepend: true` 注册，**没有 patch 或 fork DSH 任何代码**。
  通道契约是文档化的，所以接飞书之外的传输是**新增一个文件**，不是重写。
- **最小权限 + 只需出网。** 一键扫码只申请三个 scope、一个事件、一个回调，
  基于最小应用预设。投递走长连接，**不需要公网 IP、域名、端口转发或内网穿透**；
  凭据放在凭据库里，不进进程环境变量。

**安装就是扫一次码。** 设置卡片上出现二维码，扫码即完成应用创建、权限、事件订阅、回调，
并记录接收人。已有应用也可以直接填 App ID 与 App Secret，插件会**先向平台校验**再连接。

**还没验证到的部分（如实说明）**：一键创建、长连接、卡片投递、卡片回调回到 Host
都已在真实租户上跑通；卡片回调的字段路径、选项整行、自由文本回答是在那次验证**之后**改的，
测试覆盖了它们（275 个用例，不需要网络），但**还需要真机确认一次**。
凭据校验的两条分支都已在真实平台上观察过。

非官方社区插件，与 DeepSeek 无隶属关系，MIT。
[README](https://github.com/picsky/dsh-pocket-console) ·
[npm](https://www.npmjs.com/package/dsh-pocket-console)
````

### D. V2EX — 分享创造

Shorter and drier than the LINUX DO post; that board punishes marketing tone.

**标题**

```
[分享创造] DSH 口袋控制台：把工具调用审批和 ask_user_question 推到飞书，人在外面也能批
```

**正文**

````markdown
DSH（DeepSeek Harness）跑长任务时，`approval/request` 和 `user-questions/request`
都没有超时，所以人一走开，这一轮就停住了。写了个插件把这类时刻——以及一轮结束后的
结果——推到飞书卡片上：审批、提问、回复结果、开下一段任务，手机持有时还能实时看执行过程。

桌面上先答——默认给桌面 120 秒，没人答才发到手机；手机上点一下按钮，Agent 继续跑。
反过来的方向也做了：你在手机上答完之后，桌面那个还开着的页面会自己结算，不用再点一次。

提问是整组铺开的：进度、多选、选项旁边的自由输入，一次提交全部答案。
另外可以打开"结果通知"，会话停下来后把结果发到手机，附一个输入框，写的内容直接接着那个会话跑；
跑完的一段还能从手机直接开下一个任务。

安装：

    dsh plugin --profile web add dsh-pocket-console

一键扫码会创建并配好飞书应用，只申请三个 scope、一个事件、一个回调；走长连接，
不需要公网 IP 或内网穿透。

如实说一下验证程度：一键创建、长连接、投递、回调回到 Host 都在真实租户上跑通过；
卡片回调的字段路径和自由文本回答是之后改的，测试覆盖了但还需要真机确认。
非官方插件，MIT，与 DeepSeek 无关。

https://github.com/picsky/dsh-pocket-console
```

### E. Show HN

**Title**

````
Show HN: DSH Pocket Console – Approve your coding agent's tool calls from Feishu on your phone
```

**Body**

```markdown
DeepSeek Harness resolves tool approvals and `ask_user_question` prompts through Cordis
waterfall events, and neither has a timeout. The consequence is that an unattended run
does not fail when it needs you — it waits, indefinitely, until you come back to the
browser.

This plugin registers on both waterfalls with `prepend: true` (the shipped Web
forwarding listener does not call `next()` while a browser is connected, so an answerer
behind it would never run) and calls `next()` first, then races a timer. The desktop
keeps answering exactly as before; after a configurable head start the same request also
goes out as a Feishu interactive card.

The phone side covers the whole loop: approvals, `ask_user_question` questions, a
finished run's result with a box to reply in, the next task it can hand you — and, while
the phone holds the person, the run's live progress on a card that is edited in place.

Two design decisions worth calling out:

- The phone is a fallback, not the default. The interesting case isn't "I'm away", it's
  "I'm right here" — a queue of notifications makes the desk worse.
- When the phone does answer, the browser half mirrors that decision onto the open page's
  composer through the same client call a click makes, so the page doesn't sit there
  waiting on a decision that already happened. The Host can't do this: the gateway only
  finishes a forwarded request when a browser answers it.

Setup is one scan: the Settings card shows a QR code that creates the Feishu app and
configures its three scopes, one event, and one callback. Delivery uses the long
connection, so there is no public IP, domain, or tunnel.

It's a real DSH plugin rather than a wrapper — a `dsh.bundle` profile layer, no patching
or forking — with a documented channel contract so another transport is a new file.
28 decision records, 275 tests that need no network, and an e2e job that installs the
packed tarball into a real `dsh web` to prove it activates.

Not everything is phone-verified yet: the one-scan flow, long connection, delivery, and
card actions were confirmed against a live tenant, but the card-action field path and
typed answers shipped after that pass and still need a device to confirm. Both branches
of the credential check were observed live.

MIT, unofficial, not affiliated with DeepSeek.
https://github.com/picsky/dsh-pocket-console
```

### F. Media / listicle pitch (email or DM)

Short, personal, no template smell. Send three lines and a link, not a press release.

```markdown
你好，

看到你整理过 DSH 插件清单，推荐一个我自己写的：
dsh-pocket-console —— 把工具调用审批、提问、结果回复和下一段任务推到飞书卡片，
桌面优先、手机兜底，手机答完桌面会自己结算，手机持有时还能实时看执行过程。

装法一行：dsh plugin --profile web add dsh-pocket-console
仓库：https://github.com/picsky/dsh-pocket-console（MIT，非官方）

有个 10 秒的 GIF 演示绑定和审批的完整闭环，需要的话我发你。
不确定它够不够格进你的清单，如果不够也完全没问题。
```

English equivalent:

```markdown
Hi — I saw your roundup of DSH plugins and wanted to put one in front of you:
dsh-pocket-console forwards approvals, ask_user_question prompts, result replies, and
the next task to Feishu cards, desktop-first with the phone as fallback, the desktop
composer settles itself after a phone answer, and the run's progress is live on a card
while the phone holds you.

Install is one line: dsh plugin --profile web add dsh-pocket-console
Repo: https://github.com/picsky/dsh-pocket-console (MIT, unofficial)

There's a 10-second GIF of the whole loop if that's useful. No worries at all if it
doesn't fit your list.
```

### G. Reply bank

Keep these short. The three questions every launch gets:

**"Why not Telegram / Slack / ntfy?"**
The core is transport-agnostic — the channel contract is documented and Feishu is one
implementation, so another transport is a new file rather than a rewrite. Feishu is what
this deployment needed and what the one-scan app creation could be built against; the
scan flow is the reason the setup is one step instead of a bot token and a chat id.

**"Why not just forward everything to my phone?"**
Because the interesting case isn't being away, it's being right there. Sending everything
to the phone makes the desk worse to use, so the desktop answers first and the phone is
what happens when nobody does. That is also why the desktop composer is mirrored: the
phone should not leave the page stuck.

**"Isn't this a security risk — approving tool calls remotely?"**
It is a remote authorization channel, so it's built like one: grants are one-shot
(`allowed-once`), a press is honoured only from the bound recipient, the binding itself
cannot be taken over by another account or a group message, callbacks carry a single-use
id, an answer must name an option the question actually offered, and every route sits
behind the connection's trust fence. Secrets live in the credential store, not the
process environment. `SECURITY.md` lists the invariants if you want to check them.

---

## 5. What not to do

- **Never buy stars.** Reported market rates make this trivially detectable, and it
  permanently poisons credibility with exactly the maintainers and list curators whose
  attention is worth having.
- **No upvote solicitation or voting rings.** Hacker News penalises the domain, not
  just the post.
- **No tag spam.** See §2.
- **Do not overclaim.** The README's *Limitations* section says the one-scan flow, card
  delivery, and card actions were verified against a live tenant but that the
  card-action field path and typed answers shipped after that pass and still need a
  phone to confirm. Keep that in every launch post. A reviewer who finds the README
  contradicting a brag costs more than the brag gains.
- **Do not assume the ecosystem is safe ground.** DSH has had a reported sandbox-escape
  class of issue, and third-party plugin permissions have been reported as not always
  taking effect. For a plugin whose purpose is granting remote approvals, the Security
  section is the feature to lead with, not a footnote.

---

## 6. After the launch

- Watch issues daily for the first two weeks; an install bug found by the first wave is
  cheap, the same bug on Hacker News day is not.
- Every fix that changes behaviour goes under **Unreleased** in `CHANGELOG.md` — a
  deployment reads that before upgrading.
- When a second channel ships, revisit
  [ADR 0009](../docs/decisions/0009-a-channel-is-one-file.md) first.
