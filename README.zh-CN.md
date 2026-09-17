# dsh-pocket-console

**把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装进你的口袋。** 当你离开电脑，`dsh-pocket-console` 会把两个**会让 Agent 卡住**的时刻——**工具调用审批**和 **`ask_user_question` 提问**——以飞书交互卡片的形式送到手机上，随时随地批准或作答。

[![npm](https://img.shields.io/npm/v/dsh-pocket-console?label=npm&color=4b6bfb)](https://www.npmjs.com/package/dsh-pocket-console)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)
![DSH bundle](https://img.shields.io/badge/DSH-bundle%20plugin-4b6bfb)

[English](README.md) · 简体中文

> **非官方项目。** 由社区成员独立开发和维护，与 DeepSeek 无隶属关系，也未经过其审核或推荐。安装任何第三方插件前请自行甄别。

---

## 要解决的问题

无人值守的 DeepSeek Harness 在需要你的时候**不会失败，而是等待**。两条 seam 都没有超时：

- 需要审批的工具调用，只有在 answerer 给出结论后才 resolve，这一轮就停在那里。
- `ask_user_question` 以完全相同的方式阻塞。

关上浏览器走开，Agent 就一直卡到你回来。`dsh-pocket-console` 就是那个能找到你的 answerer。

## 它能做什么

- **桌面优先**：请求先给桌面 GUI。在桌面上答了，手机完全不会被骚扰。
- **手机兜底**：`delaySeconds` 秒内桌面没应答，才发飞书卡片。点一下按钮，Agent 立刻继续。
- **两条 seam 都覆盖**：审批和提问，不是只做一半。
- **是真正的 DSH 插件，不是外壳**：以 `dsh.bundle` profile 层分发，在两条有文档的 answerer waterfall（`approval/request`、`user-questions/request`）上以 `prepend: true` 注册，并以自己的命名空间贡献一张设置卡片。没有 patch 或 fork DSH 的任何代码。
- **扫码即装**：设置卡片上出现二维码，扫码后飞书应用、权限、事件订阅、回调、以及你的接收人 id **全部自动配置完成**。
- **只需出网**：走飞书 WebSocket 长连接，不需要公网 IP、域名、端口转发或内网穿透。
- **核心与通道解耦**：飞书只是一个按契约实现的传输。接 Telegram、企业微信、钉钉或 ntfy 是**新增一个文件，不是重写**。

<!-- 演示：录一段 GIF（设置卡片 → 扫码 → 手机收到审批），存为 assets/demo.gif，
     然后把这段注释替换为：
     <p align="center"><img src="assets/demo.gif" alt="在设置卡片绑定并从手机审批" width="720"></p> -->

## 快速开始

从 [npm](https://www.npmjs.com/package/dsh-pocket-console) 安装。发布的 tarball 已经把飞书通道内置其中，所以安装过程不会解析出任何需要构建许可的依赖，也不会执行任何安装期脚本：

```sh
dsh plugin --profile web add dsh-pocket-console
```

`pnpm pack` 产出的 tarball 装法相同：

```sh
dsh plugin --profile web add ./dsh-pocket-console-<version>.tgz
```

直接从 GitHub 安装也可以，但 git 依赖会从 registry 解析它自己的依赖，于是通道带进来的
`protobufjs` 的 postinstall 会让 pnpm ≥11 中止首次安装。pnpm 会往 profile 的
`pnpm-workspace.yaml` 追加一条占位项，那不是决定——把它设为 `false`，再重新执行：

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  protobufjs: false
```

```sh
dsh plugin --profile web add github:picsky/dsh-pocket-console
```

重启 `dsh web`，打开 **设置 → 插件 → 插件配置 →「Pocket console」**：

1. 点「开始绑定」
2. 卡片上出现二维码
3. 用飞书扫码（或在手机上打开同一链接）
4. 卡片变为「已绑定」并显示接收人

以上就是全部配置。飞书应用、权限、长连接、接收人 id 都来自飞书官方的**一键创建应用**
（[OAuth 2.0 Device Authorization Grant](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)），
链接 **10 分钟内有效、仅可使用一次**。

**只扫这一次。** 应用凭据与接收人都存在凭据库里，之后每次启动 `dsh` 都会自己把长连接接回来——
不用进设置、不用点按钮。只有在你点过「解绑」，或者主动点「重新绑定」时，才会再出现扫码。

卸载：

```sh
dsh plugin --profile web remove dsh-pocket-console
```

## 工作原理

DSH 通过 Cordis **waterfall 事件**解析这两件事，而 Web GUI 只是每条链上的一个 answerer：

```
approval/request          ─┐
                           ├─→ dsh-pocket-console ─→ 通道 ─→ 你的手机
user-questions/request    ─┘         │
                                     └─→ next() → 桌面 GUI → 其它 answerer
```

撑起整套设计的只有两点：

- **必须 `prepend: true`。** GUI 的转发器在浏览器连上时不会调用 `next()`，排在它后面的 answerer **永远不会执行**。
- **先 `next()` 再和计时器竞速。** 桌面链路照常跑；谁先答谁生效。审批语义完全不变——授权仍然是一次性的（`allowed-once`）。

浏览器卡片通过客户端的**设置作用域**（settings scope）修改上面这些设置：每次写入都以它读到的
revision 为栅栏，只有点「保存」才真正落盘。绑定与状态则走**同源 HTTP 路由**
（`/__pocket/state`、`/bind`、`/unbind`、`/qr.svg`），而不是 Remote 方法：Remote 的类型面是生成的、
转发事件白名单由 Host 拥有，**外部插件两者都插不进去**；同源路由天然复用浏览器已有会话，不需要 token。
`/state` 回报绑定状态、生效中的设置，以及**当前所有未结算的升级请求**——每一个是什么、是否已经送到手机。
设置分区与路由都通过 `ctx.inject` **跟随服务**，而不是在加载时读一次快照：所以没有设置 provider 的部署
不装分区、没有 webServer 的部署改为把绑定链接打进日志而不是提供卡片，两种情况下插件都照常加载，
服务一旦出现，对应的一半就会出现。

## 提问在手机上怎么显示

`ask_user_question` 一次可以问**多个问题**（`questions` 是数组），答案一次性回给模型。
桌面 GUI 是逐题翻页、带 "2 / 3" 计数；手机卡片一次全列——这是有意的：

| | 桌面 GUI | 手机卡片 |
|---|---|---|
| 布局 | 一次一题，带上一题 / 下一题 | 全部可见，可任意顺序作答 |
| 选项 | 列表，每项带说明 | 每个选项独占整行按钮，说明以图例放在正文 |
| 自由输入 | 选项旁边始终可用 | 选项旁边始终可用，且与选项同一次提交 |
| 已答 | 翻页离开后看不到 | **原地保留**，显示 `✅ 你的选择`，移除该题控件 |
| 提交 | 只有最后一题才出现「提交」 | 全部答完**自动** resolve |

一屏全列更适合手机：飞书每次改写卡片都是一次网络往返，翻页式向导会把"答三题"变成三次等待，
而小屏上滚动本来就比翻页自然。但它绝不能变成一个"点了没反应"的卡片，
所以**每答一题都会改写卡片**：进度行前进、已答题目变成 `✅ 答案`、其余保持可点。

各题形态：

- 有选项、单选 → 每个选项一个整行按钮，同题另附「提交其他回答」自由文本
- 有选项、多选 → 勾选组件 + 可选的「补充说明」，一次提交一起回传
- 没有选项 → 自由文本输入框 + 「提交本题」
- 选项带 `description` 时，说明以正文里的「选项」图例呈现——按钮标签放不下它

桌面端会跟着走。手机上给出的答案会被镜像到本页自己的面板上，走的是和"在桌面上点一下"完全相同的那次客户端调用，
于是请求结算、面板消失，而不是继续等一个已经做过的决定。审批也走同一套镜像。
之所以由浏览器这侧动手，是因为 Host 撤不掉一条已经转发出去的请求：gateway 只在浏览器回包时才结束它。
浏览器半边会把每次尝试回报给 Host——`loaded`、`watching`、`applied`，或带着原因的 `skipped`——
Host 记录进日志，并把最近几条挂在 state 路由上；镜像没生效时，它能说明卡在哪一步。

## 结果通知

审批和提问都是请求：harness 在等，通道也在等。结果通知是反方向——你放着不管的会话停下来了，结果主动发到手机上。

把 `resultNotify` 设成 `idle`：会话安静下来后，手机会收到一张卡片，上面是这一轮的**结果**，外加一个输入框。
在那里写下一条指令发出去，它就会作为新消息进入同一个会话，带着原来的上下文继续干活。
全程不经过桌面，也不等桌面，所以不会像请求那样把卡片晾在那里。

结果就是 Web GUI 不折叠的那条消息——本轮最后一条"说了话、但没有调用工具"的 assistant 消息。
这一轮里其它内容都是 GUI 折叠掉的过程，通知里不带。

以下情况不会通知或会延后：

- `resultNotify` 默认是 `off`。
- 没有产出结果（只调了工具）的会话不通知。
- 通知要等 `delaySeconds` 的安静时间；会话还在干活就继续等，所以连续多轮只会合并成一条通知。
- 同一个会话两次通知之间至少间隔 `resultNotifyCooldownSeconds`。
- 子会话单独不通知，由发起它的那个会话通知。
- 已经被宿主回收的会话不会为此被唤醒，日志里会写明。
- 通知一旦不再是该会话的最新消息就停止接受回复：被更新的结果取代，或者会话有了新输入（来自任何界面）。**没有时间限制**——你第二天回来回复它，它仍然有效。
  卡片会被改写成对应说明，所以回复永远不会把"针对旧结果的指令"塞进已经走远的会话。

指令会作为**你自己的消息**进入会话，归属方式和 harness 处理人类输入一致：由人正在使用的那个界面来签发。
dsh 自己的远端客户端（编辑器里的 prompt）就是这么做的（`packages/acp/acp/src/session.ts`）。
也正是这个归属决定了它在 Web 上**可见**——其它归属会渲染成"注入的上下文"，被折进那一轮的过程里。
因此它同时带有完整的人类授权（需要人类输入的功能会接受它）；日志里它与你在桌面输入的消息无法区分。

## 配置

所有配置都有默认值，开箱即用。要调整就在自己的 profile 层里覆盖那一行——
**patch 会替换整个 `config`，所以要写全想保留的键**：

`$DSH_HOME/profiles/web/cordis.patch.yml`

```yaml
- id: pocket-console
  config:
    channel: dsh-pocket-console/providers/feishu.js
    channelConfig:
      domain: feishu          # 或 lark
      appName: Pocket console
      # receiveId: 'ou_xxx'   # 可选：跳过扫码，直接指定接收人
    delaySeconds: 600         # 桌面专享时间；0 = 两端同时可答
    maxDetailChars: 1200
    titlePrefix: DSH
    resultNotify: idle        # off（默认）或 idle
    resultNotifyCooldownSeconds: 600
```

`locale` 决定发到手机上的卡片语言：所有卡片文案来自同一个字典（`messages.js`），部署配了哪种语言就读哪种；设置卡片本身跟随界面语言。
其余字段
其中三项是**设置命名空间**，可在设置卡片里运行时修改、无需重启：`delaySeconds`、`titlePrefix`、`resultNotify`。
表里其余是**部署级**配置：它们存在是为了让部署能重新调整传输行为，普通用户不需要了解。
手机卡片语言通过 `messages.js` 跟随界面语言；`locale` 只是"从未打开过 Web UI 的部署"的兜底。

| 字段 | 默认 | 说明 |
|---|---|---|
| `channel` | `dsh-pocket-console/providers/feishu.js` | 通道模块 |
| `channelConfig` | `{}` | 通道自有配置 |
| `delaySeconds` | `120` | 桌面 GUI 单独作答的时间 |
| `titlePrefix` | `DSH` | 卡片标题前缀 |
| `resultNotify` | `off` | `idle` 表示把停下来的会话结果发到手机 |
| `resultNotifyCooldownSeconds` | `600` | 同一个会话两次结果通知之间的最短间隔 |
| `mirrorTtlSeconds` | `60` | 手机决定仍可镜像到桌面面板的时长 |
| `locale` | `zh` | 发到手机上的卡片语言（`zh` 或 `en`） |

通道配置（`channelConfig`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `appIdRef` | `DSH_FEISHU_APP_ID` | 凭据引用名 |
| `appSecretRef` | `DSH_FEISHU_APP_SECRET` | 凭据引用名 |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `receiveId` | — | 指定接收人则跳过扫码 |
| `receiveIdType` | `open_id` | `open_id` / `chat_id` / `user_id` / `email` |
| `appName` / `appDesc` | 见源码 | 扫码确认页上预填的应用信息 |
| `createOnly` | `true` | 只新建应用，绝不覆盖已有应用 |

## 安全

审批卡片本质上是一条**远程代码执行授权通道**，因此按这个标准来做：

- **授权一次性。** `allowed-once` 只对该次调用生效，之后什么都不算。
- **密钥不进环境变量。** Agent 执行的每条命令都继承进程环境，能直接把密钥读出来。
  凭据统一放 `$DSH_HOME/.credentials.yaml`。
- **应用只申请必要权限。** 从最小基座起步（`addons.preset: false`，仅机器人能力），
  只加三个权限、一个事件、一个回调——而不是默认模板那一大堆云文档 / 知识库 / 多维表格权限。
- **回填严格校验。** 按钮只带一次性随机 `rid`；答案必须来自该问题真正提供过的选项，
  请求结算后 `rid` 立即失效。
- **只有绑定的接收人能按。** 卡片本身就是一张凭证——拿到消息的人都能按它的按钮——
  所以只有操作者 `open_id` 等于绑定接收人时才受理。手机上给出的答案会变成人类归属的输入，
  这正是这个校验不可省的原因。
- **所有路由都在连接的信任围栏之后。** `/__pocket` 承载绑定、未结算请求与镜像决定，
  所以只有连接认可这次请求时才会作答（与 `/api` 面同一道围栏）；不可信的调用在任何内容被读取前
  就拿到它的 `401`/`403`。没有 connection 服务的部署退回每次变更调用都做的 `Origin` 校验，
  跨站写入一律 `403`。
- **只需出网。** 长连接不需要监听端口、公网 IP 或隧道。
- **安装不执行任何代码。** tarball 把通道内置发布，而不是让安装过程去解析它，
  所以 profile 不会安装任何声明了安装脚本的依赖，更不会执行它们；
  内置的就是官方 SDK 原样发布的代码。

## 常见问题

**从 GitHub 首次安装停在 `ERR_PNPM_IGNORED_BUILDS`。**
git 依赖会从 registry 解析它自己的依赖，于是 pnpm ≥11 会撞上 `protobufjs` 的 postinstall，
在你允许或拒绝该脚本之前拒绝完成安装。pnpm 追加的那条占位项**不是决定**——
把它设为 `false` 再重新执行即可。从 npm 安装不会走到这一步，因为通道是内置的。

**pnpm 往 profile 里写了 `minimumReleaseAgeExclude`，或者装到的还是上一个版本。**
两者都是 pnpm 对"刚发布不久的版本"的供应链策略，不是本插件要求的：它会把太新的版本压住、
把不带版本的写法解析到上一个，并把实际放行的那个记进排除项。想立刻拿到新版本就**显式指定版本**——
`dsh plugin --profile web add dsh-pocket-console@0.1.1`——之后想自动跟随发布，再改回不带版本的写法。
另外 pnpm 会缓存 registry 元数据，几分钟前刚发布的版本可能在那份缓存刷新前一直看不见。

**设置卡片没出现。**
卡片按 Host 服务的设置命名空间键控。先确认插件加载了
（`dsh --profile web --dump-config` 应列出 `# == dsh-pocket-console` 层），
然后刷新页面——已服务命名空间列表只在文档提交或重连时重读，不在注册时。

**点「开始绑定」失败，或不出二维码。**
一键创建流程需要能访问 `open.feishu.cn`。如果主机走代理，确认该域名可达。

**二维码出来了，但扫码后不完成。**
链接 10 分钟内有效且只能用一次，点卡片上的「重试」拿新的。
另外你的飞书账号必须能在所属组织内创建应用；个人版且未加入任何组织时，
先建一个免费组织并把自己拉进去。

**日志有 `ws client ready`，但点按钮没反应。**
飞书旧版「消息卡片回传交互」**不支持长连接**，只有新版 `card.action.trigger` 可以。
确认应用订阅了 `card.action.trigger`——一键创建流程已经帮你配好。

**点按钮回的是「该请求已处理或过期」。**
这次点击没有对应的存活请求：要么桌面已经先答了那条请求，要么它被取消了——
一旦产生决定就会改写卡片，按钮本应随之消失。0.1.0 之前的版本读错了卡片回调的字段路径，
**每次**点击都会回这个提示；如果 profile 里还是那个版本，升级即可。

**审批永远到不了手机。**
先确认卡片显示「已绑定」。再看 `delaySeconds`——那是桌面专享窗口，过了才会发卡。

**能和别的飞书机器人一起跑吗？**
只有在**不同应用**的前提下可以。飞书长连接是集群模式、不广播，
两个工具共用一个应用会互相静默丢回调。请新建一个应用。

**和 Auto review 预设兼容吗？**
审批不兼容。Auto review 下 `approval/policy` 为 `never`，
工具审批不再经过 `approval/request`，没有东西可以升级。提问升级仍然有效。

## 写一个新通道

核心只做四件事：两条 answerer seam、升级计时、待决注册表、决策解码。
**消息怎么送达、按钮怎么点回来，全归通道。**

一个通道就是一个 ESM 文件，导出 `create({ ctx, config, binding, log })`，
返回一个小对象——`available`、`supportsForms`、`deliver`、`update`、`subscribe`、`close`，
再加上扫码式上手可选的 `enrollmentState` / `beginEnrollment` / `clearEnrollment`。

完整契约见 [`providers/README.md`](providers/README.md)。候选通道：

| 通道 | 只需出网 | 能否回传 | 备注 |
|---|---|---|---|
| Telegram Bot | ✅ 长轮询 | ✅ 内联键盘 | `deliver` 发消息，`subscribe` 拉回调 |
| 企业微信 / 钉钉 | ✅ 长连接 | ✅ 交互卡片 | 与飞书通道结构同构 |
| ntfy | 需手机可达 | ✅ action 按钮 | 按钮回调 Host 上的小路由 |
| Bark / Server酱 | ✅ | ❌ 只推不收 | `supportsForms: false`，仅通知 |

## 已知限制

- **要在桌面上同步，桌面上得开着这个页面。** 浏览器半边读取本页已有的待处理交互，把手机的答案
  按"点击"的同一路径应用上去，于是面板和点桌面一样结算。没有开页面就没得同步——答案照样到模型、
  会话记录里也有——但事后重新打开的页面不会重放它：镜像只在一分钟内有效。
- **卡片文本按字节限额**，不是字符数：飞书卡片消息的请求体上限是 30 KB，而一个汉字占 3 字节，所以插件把文本限制在 9 KB（约 3000 汉字）以内，并在截断时明确说明。超长的 `plan-review` 计划会以开头部分送达，决策按钮照常可用。
- **结果通知不会唤醒已被回收的会话。** 如果宿主已经把 agent 放掉，这条通知会被跳过并写进日志，而不是恢复会话。
- **长连接每应用最多 50 个，且不广播**——同一个飞书应用不要同时跑多个 DSH 实例。
- **浏览器半没有构建步骤**，所以是手写的客户端模块工厂格式，用基础 React 元素渲染，
  没有使用共享 UI 组件库。
- **发布出来的包约 4 MB**，因为它把飞书通道连同该通道自己的依赖一起装进了 tarball。
  这正是安装不需要任何构建许可的原因；安装它的机器上不会编译任何东西。
- **已在真实飞书租户上验证过，但尚未覆盖本版本。** 一键创建应用、长连接、卡片投递、
  以及卡片回调回到 Host，都在真实应用上跑通过了。卡片回调的字段路径、选项整行、
  以及自由文本回答是在那次验证**之后**才改的：测试覆盖了它们，但仍需真机确认一次。

## 开发

纯 ESM JavaScript，**无构建步骤**——这里没有任何东西需要编译，测试也不需要先安装。
唯一会碰到依赖的操作是发布：通道被打进 tarball（`bundleDependencies`），
所以要在 `pnpm pack` / `pnpm publish` 之前先 `pnpm install`，这样消费方的 profile
不会解析出任何被闸门拦下的包；缺少它时 `prepack` 会直接拒绝打包。

```sh
npm test
```

`npm run e2e` 是另一件事：它把打好的 tarball 装进一个临时 profile、真启动 `dsh web`，
用来证明插件**真的被装配起来**——这一步需要 CONTRIBUTING 里写明的 `dsh` 版本。

**不需要先装任何东西**：测试套件通过 Node 的模块解析钩子（`test/hooks.mjs`）
把五个生产依赖换成桩，因此不需要凭据也不需要网络。

39 个用例覆盖：设置命名空间与路由注册、未绑定时不升级、unbound → awaiting → bound 状态机、
二维码路由、跨源拒绝、解绑清理、解绑与迟到扫码的竞态、延时发卡、卡片内容、按钮回填、桌面优先抑制、
多题累积与卡片改写、多选表单（含与补充说明一起提交）、自由文本、伪造选项拒绝、消息重新绑定、待审批明细、
没有可选服务的部署与它们的迟到到达、运行时设置生效、取消、卸载、失败降级、
结果通知的投递与一次性指令回传、关闭/忙碌/子会话下的静默、通知冷却、
通知在被取代或会话有新输入时拒绝回复、迟到回复仍被接受、重启后凭据直连（不触发扫码）、
手机卡片跟随界面语言、超长详情与超长结果按字节预算截断、被平台因体积拒绝的卡片自动减半重投、
镜像报告只进状态路由而不刷日志、同一会话与其他会话各自的面板跃迁，
以及浏览器半"每个标签都配自己的控件、展开时箭头朝上"的渲染断言。

本地用 `--patch` 调试时，把 `channel` 指向相对路径：

```yaml
- insert:
    - id: pocket-console
      name: ./index.js
      config:
        channel: ./providers/feishu.js
```

## 许可

[MIT](LICENSE)
