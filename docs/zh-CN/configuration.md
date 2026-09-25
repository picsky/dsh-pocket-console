# 配置

[← 全部文档](../README.md)

所有配置都有默认值，开箱即用。这一页是"想改某一项"时的参考。英文版为
[../configuration.md](../configuration.md)。

## 覆盖某一项

配置写在你自己 profile 层的那一栏里。**patch 会替换整个 `config`，所以要写全想保留的键**：

`$DSH_HOME/profiles/web/cordis.patch.yml`

```yaml
- id: pocket-console
  config:
    channel: dsh-pocket-console/providers/feishu.js
    channelConfig:
      domain: feishu          # 或 lark
      appName: DSH Pocket Console
      # receiveId: 'ou_xxx'   # 可选：跳过扫码，直接指定接收人
    delaySeconds: 120         # 桌面专享时间；0 = 两端同时可答
    titlePrefix: DSH
    resultNotify: idle        # idle（默认）或 off
    resultNotifyCooldownSeconds: 0
    mirrorTtlSeconds: 60
    locale: zh
    debug: off
```

上面这份示例里每个键写的都是代码当前的默认值，所以照抄不会改动任何行为。
`npm run check:parity` 会把这份示例、两页配置表、插件 schema、设置卡片和 bundle patch
一起对齐——不只对齐**键名**，也对齐**默认值**：写在文档里却和代码不一致的默认值，
会被当成一句承诺来读。

## 可在运行时修改的设置

其中四项是**设置命名空间**：可以在设置卡片里改（设置 → 插件 → 插件配置 →「口袋控制台」；
DSH 0.1.7 起同一张卡片在侧边栏的**插件**页里、本插件自己的配置页上），
下一次决策就生效，无需重启。下表里标 ★ 的就是它们。

## 全部设置

| 字段 | 默认 | 说明 |
|---|---|---|
| `channel` | `dsh-pocket-console/providers/feishu.js` | 通道模块 |
| `channelConfig` | `{}` | 通道自有配置 |
| `delaySeconds` | `120` | ★ 桌面 GUI 单独作答的时间 |
| `titlePrefix` | `DSH` | ★ 卡片标题前缀 |
| `resultNotify` | `idle` | ★ `idle` 表示把停下来的会话结果发到手机；`off` 表示只保留实时请求 |
| `resultNotifyCooldownSeconds` | `0` | 同一个会话两次结果通知之间的最短间隔 |
| `mirrorTtlSeconds` | `60` | 手机决定仍可镜像到桌面面板的时长 |
| `locale` | `zh` | 发到手机上的卡片语言（`zh` 或 `en`） |
| `debug` | `off` | ★ `on` 会把插件对每张卡的决定写进部署日志：为什么发、为什么改、为什么跳过 |

**卡片行为无法解释时，先打开 `debug`。** 一张**没有被改写**的卡和一张**改写失败**的卡，
在手机上长得一模一样，而跳过改写的那条分支是**刻意沉默**的——所以不打开它，唯一症状就是
"什么都没变"。打开之后，每一个决定都有名字。

**这些行去哪了**：一份进部署日志，**另一份进它自己的文件**——
`$DSH_HOME/pocket-console-debug.log`，也就是 `~/.dsh/pocket-console-debug.log`
（除非你设了 `DSH_HOME`）。之所以要有文件，是因为**日志级别不归这个插件管**：
Cordis 允许导出器按名字设级别，默认是 `info`，所以 `log.debug` 只有在**宿主**以 debug
启动时才会到终端。一个写着"打开它就能看原因"、却在默认部署上什么都不显示的开关，
会让人以为这个插件无话可说——那比没有开关更坏。

所以：打开 `debug` → 复现 → 读 `~/.dsh/pocket-console-debug.log`。
开头会写明模式，之后每一行是一个决定：创建了卡、改了卡、**跳过了卡以及为什么**、
本该改写却没改。而**报告失败**的那些行仍然是警告，不开这个也看得见。

表里其余是**部署级**配置：它们存在是为了让部署能重新调整核心行为，普通用户不需要了解。

`delaySeconds` 是唯一值得想一下的：它是桌面的专属时间，`0` 表示两端同时可答。
只从手机处理审批的部署想要 `0`；守在桌面旁的部署想要一个宽裕的窗口——
因为一张在你正盯着它描述的那个对话框时到达的卡片，只是噪音。

`mirrorTtlSeconds` 是手机决定还能被浏览器半边应用到桌面面板的时长：
长到够覆盖一个已经打开的页面，短到重新加载的页面绝不会重放一个旧答案。

`locale` 决定发到手机上的卡片语言：所有卡片文案来自同一个字典（`messages.js`），
部署配了哪种语言就读哪种；`locale` 只是"从未打开过 Web UI 的部署"的兜底。

## 通道配置

`channelConfig` 原样透传给通道，字段集由**通道自己**解释和校验。这一页列的是飞书通道的：

| 字段 | 默认 | 说明 |
|---|---|---|
| `appIdRef` | `DSH_FEISHU_APP_ID` | 凭据引用名 |
| `appSecretRef` | `DSH_FEISHU_APP_SECRET` | 凭据引用名 |
| `domain` | `feishu` | `feishu` 或 `lark` |
| `receiveId` | — | 指定接收人则跳过扫码 |
| `receiveIdType` | `open_id` | `open_id` / `chat_id` / `user_id` / `email` |
| `appName` / `appDesc` | 见源码 | 扫码确认页上预填的应用信息 |
| `createOnly` | `true` | 一键流程只用于新建；已有应用用它自己的凭据绑定 |

写一个飞书之外的传输见 [providers/README.md](../../providers/README.md)。
