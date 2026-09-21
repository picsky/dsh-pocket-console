# 0026 — 委派出去的会话不是一场对话，不发卡

**Status:** accepted.

## Context

真机报告（issue #62）：**一次执行过程中卡片连着来两张，两张对应同一个执行过程**。日志定位到的机制：

```
04:17:13.739  收到动作：payload={"nid":"n8e26b87767dd4278afb4","submit":true,…}     ← 你在手机上回了张卡
04:17:13.744  活动卡：接过消息 om_x100b643ea041b4a8b18a691df66ca04 作为「session-bd85eaa4-…」的卡
04:17:13.996  活动卡：为「32e503b8-…」创建——这一轮会响。                            ← 同一毫秒
04:17:13.997  活动卡：为「3cce374d-…」创建——这一轮会响。                            ← 两张卡
```

`32e503b8` / `3cce374d` 的会话头写着 `"origin":"subagent","parentSession":"session-bd85eaa4-…"`——
它们是父会话派出去的两个子代理。同一天的 05:11:08、05:18:52 又各出现一次同样的一对。本机共 **82 个子代理会话
对 21 个普通会话**，所以是"经常遇到"而不是偶发。

两个生产方都问错了问题：

- **结果卡**。`results.js` 本来写着 "Only a session a person started is worth reporting; a delegated one is
  reported through the session that asked for it."，但条件只判断 `source.kind === 'user'`——而子代理的派发
  提示词**就是** `{ kind: 'user' }`（真机观测：无 `rpcId`，与真人打字同形，只有桌面手敲才带 `rpcId`）。
  于是每个子代理的 turn 结束都各发一张：四个子代理的 `turn/end`（seq + 时间）与通知存储里的记录逐条相等。
- **活动卡**。`turn/start` **无条件**给任何会话建记录，手机接手时 `onPriority()` 把 registry 里每个
  `status === 'running'` 的会话都收纳一张——这就是上面那同一毫秒的两条 `创建…会响`。

**这条规矩其实早就写下过**：`docs/troubleshooting.md` 与 `docs/zh-CN/troubleshooting.md` 都把
"delegated sessions / 子会话"列为"会话跑完了却什么都没收到"的正常情形之一——也就是说，文档承诺过
"委派会话不通知"，只是代码没有实现这句承诺。这次不是新增一条规矩，而是把已经写下的那条补上。

## Decision

**委派出去的会话一律不发卡**：不建活动记录、不发结果通知、手机接手时不收纳。父会话的卡照旧，一次任务
在手机上只对应它。

判据是**会话自己的创建头**：`session.header.origin === 'subagent'`。

- 它是公开且**始终存在**的字段（`dsh-session` 的 `Session` 类声明了 `header`，注释写明"总是存在"），
  `origin` 的校验**只接受 `"subagent"` 这一个值**（`dsh-session/lib/types/index.js:337-353` 与 `:55-56`）。
- 它是**读**出来的，不是**记**下来的：插件启动前就已存在的会话一样判得出来，不需要任何状态或 LRU。
- `session/event` 的第二个参数就是 `Session` 实例，`results.js` 早就在读 `session.header.cwd`（工作区名）——
  同一条读法，不是新机制。

**只看 `origin`，绝不看 `parentSession`**：`fork()` 产生的会话也带 `parentSession`，而 fork 是**人在用**的
会话，把它静音等于把手机从一场真实对话旁边拿走。

配套的三条：

- **escalation 不过滤**。需要人回答的请求必须仍然送到人手里；何况委派会话的审批策略是 `never`
  （真机观测：`approval/policy {"policy":"never","source":"delegation"}`），它本来也发不出审批卡。
- **`run-record` 不记委派会话**。没有任何卡会读它的折叠，而那张 map 有 64 条上限——一次 fan-out 足以把
  真会话的折叠挤出去。
- **历史遗留的 notice 在 restore 时退场**。这张卡此后永远不会再被改写，留着就是一个"收得下回复、但没人
  会动"的邀请；判不出来时（没有活 agent）保守保留，别的规则照旧。

**被跳过要留下一句话**：结果侧在委派会话第一条"像人话"的消息上写一行 diagnostic
（`结果卡：跳过「X」——这是被委派出去的会话，结果由发起它的会话汇报。`）。"为什么这个会话没有卡"
只能靠这句话回答——它就是这张 issue 能被定位的原因。

## Consequences

- 一次任务在手机上只多出父会话的卡。父会话本身仍是 0021 的设计（活动卡 + 每轮结果卡，回复后那张卡成为
  该轮执行卡）。
- 新模块 `delegated.js`：一个纯函数 `isDelegated(session)` 加一个常量。三个消费点——`activity.js` 的
  `observe` / `onPriority`、`results.js` 的 `onEvent` / restore、`index.js` 的 run-record 订阅。
- 委派会话照旧写自己的日志、照旧可以继续被派活，只是**不通知手机**。
- 拿不到 header 的会话（裸 `{ id }`、store 没给头的会话）**不算委派**：这个方向的默认值是"照旧发卡"，
  宁可多发一张也不静默吞掉一场真实对话。

## Alternatives

**靠 `source.kind !== 'user'` 排除。** 不可能：派发提示词就是 `{ kind: 'user' }`（真机观测），这正是原来
那道闸门形同虚设的原因。

**靠 `parentSession !== undefined` 排除。** 会把 fork 一起静音（见上）。

**改用事件判定（`subagent/descriptor`）。** 它是子代理会话日志的**第一条**事件（seq 0，早于 `turn/start`
的 seq 5），也确实是备用信号；但它需要记住"这个会话是委派来的"，而 header 直接就能回答，所以先不引入状态。
记在 `internal/boundaries.md` 里，作为上游改 header 时的退路。

**把子代理的进展并进父卡。** 信息更全，但要动折叠与归属逻辑，回归面大；issue #62 选的是最小可测的那一步。

**等 `agents` 服务给出"这是子代理"。** 上游 agent 对象没有这个字段（全仓 grep 过），header 才是现成的。

## What would reopen this

- 上游不再往 header 写 `origin`（那时改判据，退回 `subagent/descriptor` 事件）。
- 人真的想在手机上跟进某个子代理（那时要的是显式的"关注这个会话"，而不是让所有子代理都发卡）。
- 委派会话开始出现需要人回答的场合（那时 escalation 的不过滤也要一起重看）。
