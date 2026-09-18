# dsh-pocket-console

**别把整台电脑交出去——只把那个卡住它的决定交出去。**

当你离开工位，无人照看的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 不会失败，
它会**等**。`dsh-pocket-console` 只把需要人的那两个时刻——**工具调用审批**与 **`ask_user_question` 提问**
——在桌面答不上来之后，以飞书卡片送到你手机上。除了那个决定本身，没有任何东西被搬到手机上。

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![CI](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml/badge.svg)](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

[English](README.md) · 简体中文

> **非官方项目。** 由社区成员独立开发和维护，与 DeepSeek 无隶属关系，也未经过其审核或推荐。安装任何第三方插件前请自行甄别。

---

## 三件事定义它

- **桌面优先，默认为它留 120 秒。** 每个请求先到桌面 GUI。在那里答了，手机全程不会被碰。
  只有在 `delaySeconds` 秒内没人应答，同一个请求才会变成一张带按钮的飞书卡片。
  **一次不需要的通知，比没有通知更糟。**
- **手机拿到的是一次性决定，别的什么都没有。** 卡片上有请求、原因和选项。批准等同于桌面按钮
  给出的 `allowed-once`，承载它的随机 id 在请求结算的瞬间失效。没有工作区、没有会话列表、
  没有设置、没有凭据。**手机丢了，损害的上界是一次回答。**
- **只需出网。** 一条到飞书的 WebSocket 长连接。不需要公网 IP、域名、证书、端口转发、
  隧道或中继。你的机器不会有任何东西从公网变得可达。

## 快速开始

发布的 tarball 已经把飞书通道内置其中，所以安装过程不会解析出任何需要构建许可的依赖，也不会执行任何安装期脚本：

```sh
dsh plugin --profile web add dsh-pocket-console
```

重启 `dsh web`，打开 **设置 → 插件 → 插件配置 →「Pocket console」**：

1. 点「扫码创建应用」，或「使用已有的应用」。
2. 用飞书扫码（链接 10 分钟内有效、仅可使用一次）。
3. 卡片报「已绑定」，并列出**应用**、**接收人**、以及**长连接是否已建立**。

设置就这些。应用凭据与接收人 id 都存在凭据库里，之后每次启动 `dsh` 都会自己把长连接接回来——
不用再进设置，也不用再扫一次。

**完全不扫码**也可以：把应用凭据放进凭据库，键名就是 `DSH_FEISHU_APP_ID` 与
`DSH_FEISHU_APP_SECRET`（即 `appIdRef` / `appSecretRef` 指向的名字）。

从 GitHub 安装也可以，但 git 依赖会让 pnpm 去解析通道自己的依赖，于是 `protobufjs` 的
postinstall 会让 pnpm ≥ 11 中止首次安装。把 pnpm 追加到 profile `pnpm-workspace.yaml`
里的占位项设为 `false` 再重试：

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  protobufjs: false
```

卸载：`dsh plugin --profile web remove dsh-pocket-console`。

### 调整它

每一项配置都有 schema 默认值，所以这个插件完全不配置也能用。要调整某个部署，在你自己的 profile
层里覆盖那一行——一次 patch 会**整体替换该行的 `config`**，所以要把想保留的键都重新写全：

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

这就是全部键在代码当前出厂值下的样子，照抄不改任何行为。其中 `delaySeconds` 是唯一值得想的：
它是桌面端的先手时间，`0` 表示两边同时可答。`npm run check:parity` 会把这个示例、两份配置页、
插件 schema、设置卡片与 bundle patch 按住同一套**名字和默认值**。
其余每一项见[配置参考](docs/zh-CN/configuration.md)。

## 数据去了哪里

```
approval/request          ─┐
                           ├─→ dsh-pocket-console ─→ 飞书长连接 ─→ 你的手机
user-questions/request    ─┘         │
                                     └─→ next() → 桌面 GUI
```

插件在两条链上以 `prepend: true` 注册，并且**先调用 `next()`**，所以桌面链路照常运行。
两个答案竞速：谁先结算谁生效。**投递出问题不会改变答案**——通道不可用时，升级逻辑放弃手机这一侧，
让桌面独自竞速，而不是用一个没人给过的答案去结算请求。

这条路径上没有我们的服务器，也没有第三方看到请求。飞书会看到卡片，因为飞书就是传输本身。

## 它是哪一类

| | 搬运什么 | 手机拿到什么 | 你需要运维什么 | 适合 |
|---|---|---|---|---|
| **整机 GUI 镜像** —— [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)、[ds-harness-remote](https://github.com/liguobao/ds-harness-remote)、[dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) | 整个 Web GUI，走局域网 / 隧道 / P2P / 托管中继 | 完整界面：工作区、会话、设置、凭据 | 一条隧道、一个中继、一个域名，或信任别人的中继 | 人不在电脑旁还要工作 |
| **IM 控制台** —— [dsh-im](https://github.com/xmanrui/dsh-im)、[dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot) | 聊天平台的长连接 | 会话、工作区、模型、权限；好几个通道 | 一个 bot 应用，常常还要走开发者后台 | 用聊天驱动 agent |
| **只做通知** —— [dsh-turn-notify](https://www.npmjs.com/package/dsh-turn-notify)、[@dsh-suite/plugin-notify](https://www.npmjs.com/package/@dsh-suite/plugin-notify) | toast、浏览器、webhook、Bark、Server酱 | 一条**无法回答**的消息 | 每个通道的 webhook 或 key | 知道"有动静了" |
| **dsh-pocket-console** | 一条出站 WebSocket | **一次决定，用完即废**——批准、拒绝、或回答 | 什么都不用 | 你离开工位时，agent 不能停 |

想让电脑跟手走，请装第一行里的某一个。这个插件服务的是另一种情况：
**电脑留在原地，只有那个决定出门。**

## 我们刻意不做的事

以下每一条，都可能是你正在找的能力——如果是，上面已经写了该用什么。

- **不搬 GUI。** 搬界面就会搬工作区、设置和凭据。
- **不做多会话管理与历史。** 那些是为了"从手机上工作"，而这里是为了"做一个决定"。
- **默认不主动推手机。** 只有在桌面没能及时应答时，卡片才会发出。
- **不让手机持有持久权限。** 授权是 `allowed-once`，权限无法累积。
- **永不自动批准。** 插件从不替你决定：**沉默不作数**。
- **不改 DSH。** 以 `dsh.bundle` profile 层分发，注册在两条有文档的 waterfall 上。
  DSH 里没有任何东西被 patch 或 fork，因此升级 DSH 不会弄坏它。
- **不监听任何入站。** 没有端口、隧道、中继，也没有第三方服务器——代价是"在任何网络都能连上"这件事我们不做。
- **不接单向通道。** 无法回传的传输（`supportsForms: false`）只能通知，不在本插件的范围内。

## 安全

审批卡片本质上是一条**远程代码执行授权通道**，所以按这个标准来做：

- **授权一次性。** `allowed-once` 只对该次调用生效；请求结算后随机 `rid` 立即失效。
- **密钥不进环境变量。** Agent 执行的每条命令都继承进程环境，能直接把密钥读出来。凭据统一放 `$DSH_HOME/.credentials.yaml`。
- **应用只申请必要权限。** 从最小基座起步（`addons.preset: false`，仅机器人能力），只加三个权限、
  一个事件、一个回调——而不是默认模板那一大堆云文档 / 知识库权限。
- **只有绑定的接收人能按。** 卡片本身就是一张凭证，所以只有操作者 `open_id` 等于绑定接收人时才受理。
  私聊只绑定尚未绑定的部署，群消息永不绑定。
- **回填严格校验。** 按钮只带一次性随机 `rid`，答案必须来自该问题真正提供过的选项。
- **连接之前先校验凭据。** 通道会先换一次 tenant token，通过之后才建立长连接；
  所以填错的 App ID / Secret 会直接显示在卡片上，而不是一直重试。
- **所有路由都在连接的信任围栏之后。** 每条 `/__pocket` 路由只在连接认可这次请求时才作答；跨站写入一律拒绝。

完整的不变式、威胁模型与上报方式见 [SECURITY.md](SECURITY.md)。

## 已知限制

这些是真实的缺口，不是选择。选择在上面两节。

- **要在桌面上同步，桌面上得开着这个页面。** 浏览器半边会重放"在桌面上点一下"的那次客户端调用，
  于是面板结算而不是继续等一个已经做过的决定。没有开页面时，答案照样到模型、会话记录里也有，
  但事后重新打开的页面不会重放它——镜像只在一分钟内有效。
- **卡片文本按字节限额，不是字符数。** 飞书卡片请求体上限 30 KB，而一个汉字占 3 字节，
  所以文本被限制在 9 KB 以内，并在截断时明确说明。超长的计划会以开头部分送达，决策按钮照常可用。
- **结果通知不会唤醒已被回收的会话。** 如果宿主已经把 agent 放掉，这条通知会被跳过并写进日志，
  而不是恢复会话。
- **一个飞书应用只服务一个 DSH 实例。** 长连接的事件不广播——飞书把每个事件只投递给其中一条连接
  ——所以两个实例共用同一个 bot 时，审批会随机落到某一侧。
- **浏览器半边是单个手写文件**，没有构建步骤，用基础 React 元素渲染，没有使用共享 UI 组件库。
- **发布出来的包约 4 MB**，因为它把飞书通道连同该通道自己的依赖一起装进了 tarball。
  这正是安装不需要任何构建许可的原因。
- **已在真实飞书租户上验证过，但尚未覆盖本版本。** 一键创建应用、长连接、卡片投递、卡片回调
  都在真实应用上跑通过。卡片回调的字段路径、选项整行、以及自由文本回答是在那次验证**之后**
  才改的：测试覆盖了它们，但仍需真机确认一次（见 [ADR 0005](docs/decisions/0005-connected-means-connected.md)）。

## 继续往下读

| 文档 | 内容 |
|---|---|
| [docs/zh-CN/configuration.md](docs/zh-CN/configuration.md) | 每一项配置、默认值，以及哪些能在设置卡片里运行时修改 |
| [docs/zh-CN/troubleshooting.md](docs/zh-CN/troubleshooting.md) | 安装、绑定，以及卡片收不到的情况 |
| [docs/decisions/](docs/decisions/) | 插件为什么长成这样，一个决定一篇记录 |
| [docs/development.md](docs/development.md) | 测试套件、真实装配检查、对着运行中的部署调试 |
| [docs/zh-CN/providers.md](docs/zh-CN/providers.md) | 通道契约：写一个飞书之外的传输需要实现什么 |
| [SECURITY.md](SECURITY.md) | 本插件声明的安全不变式 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么 |

## 许可

[MIT](LICENSE)
