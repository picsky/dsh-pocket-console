# 0020 — 手机开的会话要挂进工作区，而不是只按目录创建

**Status:** accepted.

## Context

手机开的新任务在手机上是正常的：卡片说"已开新会话"，新会话跑起来，它的结果也照常回到手机。**但在网页端，那个会话落在「未分组」里**，而不是它本该属于的项目下。

这不是显示问题。DSH 的分组是**按名册**分的：一个会话出现在某个工作区下，是因为那个工作区的 `sessionIds` 里写着它，**并且**它存储的 header 里 `cwd` 的规范形式等于工作区路径——`dsh-workspace` 的类型文档原文是：

> Membership requires both an id in that account and a session header whose canonical cwd equals the workspace path.

而写这份名册的只有一个地方。`sessionController.create` 的形状是：

```js
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
adopted = await this.agents.ensureSession(sessionId, cwd, ...)
if (workspace !== undefined) {
  await workspace.attachSession(sessionId)   // ← 只有这条分支会挂
}
```

其中 `workspace` 只在请求里给了 `workspaceId` 时才有值。这个插件当初给的是 `cwd`，所以 `workspace` 是 `undefined`，`attachSession` 整段被跳过：**会话建好了、跑起来了、prompt 也进去了，但它不属于任何工作区。**

真机上的证据（部署方自己的存储）：一条 header 为

```json
{"id":"session-4a5ad576-…","cwd":"C:\\Users\\Report02\\Desktop\\deepseek-harness","agentPreset":"standard"}
```

的会话，而 `C:\Users\Report02\Desktop\deepseek-harness` **是已登记的工作区**（`192dabe8-…`）——它的 id 却不在任何工作区的 `sessionIds` 里。

## Decision

**新会话按工作区创建，而不是按目录创建；工作区由问话会话自己的目录解析出来。**

```js
const workspace = await registry.resolveByPath(cwd)   // 规范化后按字符串匹配
created = await controller.create(
  workspace === undefined ? { cwd } : { workspaceId: workspace.id },
)
```

每条都值得单独说：

- **先解析、再创建，而不是"建完再挂"。** 成员资格是双条件，而 header 是**创建时写下的**；事后补一条 id 并不足以让它出现在工作区下,还多一个"此时 header 是否已落盘"的时序问题要赌。`workspaceId` 是 DSH 自己的入口形状，挂载发生在会话发布之前。
- **两个字段绝不同时给。** `create` 对 `workspaceId` 与 `cwd` 并存直接报 `gateway/bad-request`。
- **解析不出来就退回按目录创建，绝不因此失败。** 一个跑起来但未分组的任务，比一张什么都不做的卡片有价值。两种退回都会在部署日志里说明**它将落在「未分组」**，免得下一次报告还要靠猜。
- **目录存在但没有工作区记录时，不替用户新建一条。** 这个模块唯一的写入是"它被要求开的那个会话"；一次手机按键去**凭空发明一个工作区记录**，比卡片承诺的动作更大。这一条是刻意的收窄：如果以后真需要，应当单独决定。
- **`create` 失败要接住。** 它是在会话**已经存在之后**才去挂载的，所以失败会抛错。不接住的话，手机看到"已开新会话"，而那个会话永远收不到 prompt——一个安静的半成品。接住之后退回按目录创建，并且**prompt 只发一次**。

## Consequences

- 手机开的任务出现在它该在的项目下，和桌面开的没有区别。因为工作区控制器在持久化域变化时**会主动广播** `upsert`，**已经开着的网页不必刷新**就能看到它。
- 从手机继承的工作区，由注册表按它自己的规范化规则认定，而不是按字符串碰巧怎么写。
- 未分组仍然可能发生，但只发生在能说清原因的情况下（目录已不存在、或该目录没有工作区记录），并且会被记进日志。
- **已经产生的孤儿会话不会被自动修复。** 修好之后新开的会正确归位；旧的那些仍在未分组里，需要一次性补救或手工拖动——那是另一件事，不在这个决定里。

## Alternatives

**建完再调 `attachSession`。** 否决：成员资格还要 header 的 cwd 等于工作区路径，而 `attachSession` 是去**读存储里的 header** 做校验的，于是要赌"此时 header 已经落盘"。

**目录没有工作区记录时自动建一条。** 暂时否决，理由见上。这是本决定里唯一会改写部署方持久化状态的分支，要单独决定。

**不修，接受未分组。** 否决：这正是被报告的问题，而且用户在网页端手工把会话拖进项目，很可能并不走 DSH 的挂载 API——那样就永远修不好。

## What would reopen this

- 证据显示某些部署里 `resolveByPath` 常年解析不到（例如工作区路径是符号链接、而 header 存的是另一套拼写）：那时需要先谈统一路径拼写，而不是继续退回。
- 部署方明确希望"手机在任意目录开任务时自动建工作区"：那是一条新的、更大的写入承诺，应当有自己的决定记录。
