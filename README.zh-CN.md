# dsh-pocket-console

**出去走走，任务也不会卡住**

临走前给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 丢一个任务，本以为回来就能验收——结果它卡在方案确认那一步。

`dsh-pocket-console` 为解决这个问题而生：人不在场时也能推进卡住会话的地方。

它把那两个需要人的时刻——**工具调用审批**与 **`ask_user_question` 提问**——在桌面没及时应答之后，做成飞书卡片送到你手机上；点一下按钮，Agent 立刻继续。手机只拿到那个决定：**批准、拒绝，或回答**。工位、会话、设置和凭据都留在原处，也只需要一条出站长连接——不用公网 IP、域名或隧道。

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![CI](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml/badge.svg)](https://github.com/picsky/dsh-pocket-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

[English](README.md) · 简体中文

---

## 安装与卸载

发布的 tarball 已经把飞书通道内置其中，所以安装不会解析出任何需要构建许可的依赖，也不执行安装期脚本：

```sh
dsh plugin --profile web add dsh-pocket-console
```

重启 `dsh web`，打开 **设置 → 插件 → 插件配置 →「口袋控制台」**：

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

每一项都能「恢复默认」，改完记得保存（卡片会先标「未保存」）。

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

- **不搬 GUI。** 搬界面就要搬工作区、会话、设置和凭据——所以你也**不能在手机上翻会话、看历史、改设置**。你能做的是**开下一个任务**：当一轮在你人在手机边时跑完，卡片会提供在同一个工作区里开一个新会话。
- **默认不主动推手机。** 只有桌面没在时限内应答时，卡片才会发出——有两处刻意的例外，因为那两件事都是**有人在被阻塞**，不是状态播报：审批与提问，以及一轮跑完的结果。
- **永不自动批准。** 插件从不替你决定：**沉默不作数**。
- **不监听任何入站。** 没有端口、隧道、中继、第三方服务器——代价是"在任何网络都能连上"这件事不做。
- **不改 DSH。** 作为 `dsh.bundle` profile 层分发，注册在两条有文档的 waterfall 上，不 patch 也不 fork，升级 DSH 不会弄坏它。

## 会怎么坏

这些是真实的缺口，不是选择。

- **镜像到桌面，需要那个页面开着。** 手机答完，开着的页面会像你点了一下那样自己结算；页面没开时，答案照样到模型和会话记录，但事后打开的页面不会重放——镜像只在一分钟内有效。
- **一个飞书应用只服务一个 DSH 实例。** 长连接的事件不广播，两个实例共用一个 bot 时，审批会随机落到某一侧。
- **卡片文本按字节限额，不是字符数。** 请求体上限 30 KB，而请求体承载的并不是文本本身的长度：文本先转义进卡片 JSON，卡片 JSON 再转义一次成为请求参数，一个引号或反斜杠每层都会翻倍——而工具输出、JSON、代码里全是这些。所以文本按**请求体实际计费的字节**限制在 4.5 KB 以内，这样即使整张卡片的每个字节都再转义一次也仍然在上限之内；放不下时明确说明已截断。超长的计划以开头部分送达（约 1500 个汉字），按钮照常可用。

## 它是哪一类

| | 搬运什么 | 手机拿到什么 | 你需要运维什么 | 适合 |
|---|---|---|---|---|
| **整机 GUI 镜像** —— [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)、[ds-harness-remote](https://github.com/liguobao/ds-harness-remote)、[dsh-zen-remote](https://github.com/KyoMio/dsh-zen-remote) | 整个 Web GUI，走局域网 / 隧道 / P2P / 托管中继 | 完整界面：工作区、会话、设置、凭据 | 一条隧道、一个中继、一个域名，或信任别人的中继 | 人不在电脑旁还要工作 |
| **IM 控制台** —— [dsh-im](https://github.com/xmanrui/dsh-im)、[dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot) | 聊天平台的长连接 | 会话、工作区、模型、权限；好几个通道 | 一个 bot 应用，常常还要走开发者后台 | 用聊天驱动 agent |
| **只做通知** —— [dsh-turn-notify](https://www.npmjs.com/package/dsh-turn-notify)、[@dsh-suite/plugin-notify](https://www.npmjs.com/package/@dsh-suite/plugin-notify) | toast、浏览器、webhook、Bark、Server酱 | 一条**无法回答**的消息 | 每个通道的 webhook 或 key | 知道"有动静了" |
| **dsh-pocket-console** | 一条出站 WebSocket | **一次决定，用完即废**——批准、拒绝、或回答 | 什么都不用 | 你离开工位时，agent 不能停 |

想让电脑跟手走，装前三类里的某一个。这个插件服务的是另一种情况：**电脑留在原地，只有那个决定出门。**

## 给开发者

- **形态**：`dsh.bundle` profile 层插件，纯 ESM，**没有构建步骤**；发布包约 4 MB，因为飞书通道及其依赖内置在 tarball 里。
- **测试**：`npm test`。不需要先安装、不需要网络和凭据——生产依赖由仓库内的 stub 顶替。
- **机器门**：`npm run check:parity`（一处设置必须在六个地方一致）、`npm run e2e`（把打包产物装进真实 `dsh web`，验证它能激活）。CI 上跑的就是这些：两个 Node 版本的 `verify`、`real composition`、`publish payload`。
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
