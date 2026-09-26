# dsh-pocket-console

**出去走走，任务也不会卡住**

临走前给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 丢一个任务，本以为回来就能验收——结果它卡在方案确认那一步。

`dsh-pocket-console` 为解决这个问题而生：人不在场时也能推进卡住会话的地方。

它把人在场外时需要人的时刻做成飞书卡片送到你手机上——**工具调用审批**、**`ask_user_question` 提问**，以及一轮结束后的**结果**——桌面没及时应答之后才发卡；点一下按钮，Agent 立刻继续，手机上的回复会作为**你自己的消息**进入会话；跑完的一段还能把**下一段任务**交给你，从手机直接开。手机持有时，**执行过程**在一张原地更新的卡上实时可见。手机拿到的是决定和对话的下一步，不是机器本身：工位、会话、设置和凭据都留在原处，也只需要一条出站长连接——不用公网 IP、域名或隧道。

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![CI](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml/badge.svg)](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

[English](README.en.md) · 简体中文

---

## 安装与卸载

发布的 tarball 已经把飞书通道内置其中，所以安装不会解析出任何需要构建许可的依赖，也不执行安装期脚本：

```sh
dsh plugin --profile web add dsh-pocket-console
```

重启 `dsh web`，打开 **设置 → 插件 → 插件配置 →「口袋控制台」**（DSH 0.1.7 起，同一张卡片在侧边栏的**插件**页里、列在该页的**官方**分组下；设置页里只剩只读的插件列表）：

1. 点「扫码创建应用」；已有应用则点「使用已有的应用」，填它的 App ID 与 App Secret。
2. 用飞书扫码（链接 10 分钟内有效、仅可使用一次）。
3. 卡片显示「已绑定」，并列出**应用**、**接收人**和**长连接**（已建立 / 已断开，正在重连…）。

凭据和接收人存在凭据库里，之后每次启动 `dsh` 都会自己把长连接接回来——不用再进设置，也不用再扫一次。要换应用点「使用其他应用」；要让手机这一侧停下来，点「解除绑定」。从 GitHub 直接安装则要多放行一个构建脚本，见[故障排查](docs/zh-CN/troubleshooting.md)。

卸载：

```sh
dsh plugin --profile web remove dsh-pocket-console
```

## 调整它

插件默认配置开箱即用。

| 设置 | 默认 | 含义 |
|---|---|---|
| 桌面专享时间（秒） | `120` | 桌面在这个时间后如果还没有给出响应，则发送到手机。`0` 表示即时发送 |
| 标题前缀 | `DSH` | 手机消息标题的前缀 |
| 结果通知 | `空闲时通知` | 会话停下来后，把本轮结果发到手机，并附上一个可以直接回复的输入框。通知延迟发送时间复用桌面专享时间参数 |

每一项都能「恢复默认」。**改动怎么落地取决于宿主**：把表单交给宿主自己渲染的版本（DSH 0.1.7 起）里，改动**即时生效**，卡片不再有「保存」；旧版里卡片先标「未保存」，点「保存」才写进文档。写失败时两种版本都会在卡片上说明。

**卡片里没有的，属于部署。** 通道、界面语言、镜像时长这类设置不进卡片，在 profile 层覆盖——一次 patch 会**整体替换该行的 `config`**，所以要把想保留的键都重新写全：

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

以上是全部键在出厂值下的样子，照抄不改任何行为。逐项说明见[配置参考](docs/zh-CN/configuration.md)。

## 安全

审批卡片本质上是一条**远程代码执行授权通道**，所以按这个标准来做：

- **授权一次性。** 批准只对该次调用生效（`allowed-once`），请求结算后随机 id 立即失效。
- **手机丢了，损害的上界是一次回答——或者一个新任务。** 卡片本身就是凭证，只有绑定的接收人能按：私聊只绑定尚未绑定的部署，群消息永不绑定。回答一张卡，决定的是桌面已经开好的事；**从手机开新任务则更大**：它会在当前会话的工作区里起一轮，所以丢了手机等于能在那个项目里跑一轮——仍然受 agent 自己的审批规则约束。但它选不了工作区、够不到别的项目，也碰不到设置和凭据。
- **密钥不进环境变量。** Agent 执行的每条命令都继承进程环境，所以凭据统一放在 `$DSH_HOME/.credentials.yaml`。
- **应用只申请必要权限。** 三个权限、一个事件、一个回调，从最小基座起步，而不是默认模板那一堆云文档权限。
- **路径上没有我们的服务器。** 飞书会看到卡片，因为飞书就是传输本身。

完整的不变式、威胁模型与上报方式见 [SECURITY.md](SECURITY.md)。

## 它不做什么

- **不搬 GUI。** 搬界面就要搬工作区、会话、设置和凭据——所以你也**不能在手机上翻会话、看历史、改设置**。你能做的是**开下一个任务**：当一轮在你人在手机边时跑完，**结果卡上就带着**在同一个工作区里开一个新会话的表单——不需要另一张卡，也不需要多一次通知。而**你在结果卡上回一句**，那张卡自己就变成接下来这一轮的「执行中」——会动的那张，永远是你按的那张。
- **默认不主动推手机。** 只有桌面没在时限内应答时，卡片才会发出——有两处刻意的例外，因为那两件事都是**有人在被阻塞**，不是状态播报：审批与提问，以及一轮跑完的结果。
- **永不自动批准。** 插件从不替你决定：**沉默不作数**。
- **不监听任何入站。** 没有端口、隧道、中继、第三方服务器——代价是"在任何网络都能连上"这件事不做。
- **不改 DSH。** 作为 `dsh.bundle` profile 层分发，注册在两条有文档的 waterfall 上，不 patch 也不 fork，升级 DSH 不会弄坏它。

## 会怎么坏

这些是真实的缺口，不是选择。

- **镜像到桌面，需要那个页面开着。** 手机答完，开着的页面会像你点了一下那样自己结算；页面没开时，答案照样到模型和会话记录，但事后打开的页面不会重放——镜像只在一分钟内有效。
- **一个飞书应用只服务一个 DSH 实例。** 长连接的事件不广播，两个实例共用一个 bot 时，审批会随机落到某一侧。
- **重启窗口内的手机按键不会生效。** 审批与提问的待决表在内存里，进程重启后它跟着清空。重启期间按下的按钮不会重放；重启后按一张旧卡，会看到「请求已结束」，卡会被改写为已结束的样子——那张卡还在，但那次决定已经没了。结果卡不受影响：它走持久存储，重启后照样能回。
- **卡片文本按字节限额，不是字符数。** 文档写的上限是 30 KB，而**这个数字是错的**：用本插件自己的应用在真实租户上实测，请求体 **131 KB 被接受、164 KB 被拒**。而且请求体承载的并不是文本本身的长度——文本先转义进卡片 JSON，卡片 JSON 再转义一次成为请求参数，一个引号或反斜杠每层都要多花字节。所以文本按**请求体实际计费的字节**限制在 **32 KB** 以内，这个数是量出来的、不是抄来的；放不下时明确说明已截断。按实测的折算率，这大约是 **11,000 个汉字**（一个 60 步的计划只占约 3 KB），所以长计划是**整份送达**的，而不是只剩开头。

## 它是哪一类

| | 搬运什么 | 手机拿到什么 | 你需要运维什么 | 适合 |
|---|---|---|---|---|
| **整机 GUI 镜像** —— [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)、[ds-harness-remote](https://github.com/liguobao/ds-harness-remote)、[dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) | 整个 Web GUI，走局域网 / 隧道 / P2P / 托管中继 | 完整界面：工作区、会话、设置、凭据 | 一条隧道、一个中继、一个域名，或信任别人的中继 | 人不在电脑旁还要工作 |
| **IM 控制台** —— [dsh-im](https://github.com/xmanrui/dsh-im)、[dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot) | 聊天平台的长连接 | 会话、工作区、模型、权限；好几个通道 | 一个 bot 应用，常常还要走开发者后台 | 用聊天驱动 agent |
| **只做通知** —— [dsh-turn-notify](https://www.npmjs.com/package/dsh-turn-notify)、[@dsh-suite/plugin-notify](https://www.npmjs.com/package/@dsh-suite/plugin-notify) | toast、浏览器、webhook、Bark、Server酱 | 一条**无法回答**的消息 | 每个通道的 webhook 或 key | 知道"有动静了" |
| **dsh-pocket-console** | 一条出站 WebSocket | **决定和下一步**：一次性审批、提问、可回复的结果、开下一段任务；执行中实时可见 | 什么都不用 | 你离开工位时，agent 不能停 |

想让电脑跟手走，装前三类里的某一个。这个插件服务的是另一种情况：**电脑留在原地，只有那些决定和对话的下一步出门。**

## 支持的 DSH 版本

插件是**对着具体宿主验证**的，不是"对 DSH 一般都行"。同时支持**两个**：写这个插件时最早的、以及发布时最新的。

| DSH | 验证到什么程度 |
|---|---|
| `0.1.6-alpha.1` | 全流程：安装式设置 section + keyed 设置卡片（设置 → 插件 → 插件配置） |
| `0.1.7-rc.2` | 全流程：条目自己的 volatile `Config` + 侧边栏**插件**页 |

两条腿在每个 PR 上都跑（`ci.yml` 的 `real composition` 矩阵），发布前还会再对着**即将发布的那个 tarball** 跑一遍：装进一次性 profile、启动真实 `dsh web`、读它自己的路由、确认 boot manifest 里有本插件、并核对浏览器将执行的那份 client bundle 就是 tarball 里安装的那份。

窗口只在发布时移动：新 DSH 出现时，一次发布可以加一条腿、去掉最旧的一条，发布说明里会写明。窗口之外的版本也许能用，但这里不做承诺。

**版本策略**：版本号代表**一批**一起验证过的改动，不是"一个修复一个版本"；带预发布后缀的版本（如 `0.9.6-rc.1`）只发到 npm 的 `next` 通道，人工在真实环境跑过之后才由 `npm dist-tag add` 提升到 `latest`。所以 `latest` 永远只指向有人亲自跑过的版本。全部规则见 [docs/releasing.md](docs/releasing.md) 与[决策 0030](docs/decisions/0030-a-release-is-a-batch-a-person-ran.md)。

## 给开发者

- **形态**：`dsh.bundle` profile 层插件，纯 ESM，**没有构建步骤**；发布包约 4 MB，因为飞书通道及其依赖内置在 tarball 里。
- **测试**：`npm test`。不需要先安装、不需要网络和凭据——生产依赖由仓库内的 stub 顶替。
- **机器门**：`npm run check:parity`（一处设置必须在六个地方一致）、`npm run e2e`（把工作树打包装进真实 `dsh web`，验证它能激活与渲染入口）。CI 上跑的是 `verify`（两个 Node 版本）、`real composition`（支持窗口的每个 DSH 各一条腿，验的是 tarball）、`publish payload`。
- **动手之前**：[docs/decisions/](docs/decisions/) 记录"为什么长成这样"，[docs/development.md](docs/development.md) 说明测试与调试。
- **怎么改、怎么落地**：[CONTRIBUTING.md](CONTRIBUTING.md)（英文）；变了什么都记在 [CHANGELOG.md](CHANGELOG.md)。要写飞书之外的通道，看[通道契约](docs/zh-CN/providers.md)。

## 继续往下读

| 文档 | 内容 |
|---|---|
| [配置参考](docs/zh-CN/configuration.md) | 每一项配置、默认值，以及哪些能在设置卡片里运行时修改 |
| [故障排查](docs/zh-CN/troubleshooting.md) | 安装、绑定，以及卡片收不到的情况 |
| [docs/decisions/](docs/decisions/) | 插件为什么长成这样，一个决定一篇记录 |
| [SECURITY.md](SECURITY.md) | 本插件声明的安全不变式 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 一个改动如何落地：issue、分支、PR、四道检查（英文） |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么 |

## 许可

[MIT](LICENSE)
