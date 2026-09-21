# 0023 — 会话正在跑的时候，回复是"插话"而不是"排队"

**Status:** accepted.

## Context

真机上测一条真实的回复时发现：**会话正在跑的时候从手机回复，指令会消失。**

```
02:21:40  收到动作：{"nid":"n5ba1eb0ce6084f838a24","submit":true,…}，消息=om_x100b643d04756cb0b4b6392b345bef2
02:21:40  活动卡：接过消息 om_x100b643d04756cb0b4b6392b345bef2 作为「session-9a343e51…」的卡——不再另发一张。
```

通知被消费、卡片就地变成执行中、toast 说"已发送给 agent"——但**那一轮永远没来**：会话记录
（`turnOutline`）里 `turn 106` 之后直接是 `turn 107`，而 107 的 prompt 是 4 分钟后的另一次回复；中间
89 秒日志里一条活动卡改写都没有（说明会话确实没在跑）。

对照干净：**跑着时回复 → 丢；空闲时回复 → 成。**

`results.js` 用的是 `agent.followup()`。harness 的契约看起来没问题：

```js
followup(input) { this.send(input, "next-turn", true); }
send(message, target, wakeup) { this.inbox.splice(target, Infinity, 0, [message]); if (wakeup) this.wakeDriver(...); }
```

——"排成自己的一轮并唤醒 driver"。但那次排队**没有兑现**（inbox 现在也是空的）。**机理尚未证死**
（嫌疑在那条 inbox 的收回路径：排队项在轮结束时被清掉，或被 `claim` 走却没开出轮次），
所以这里只按**观察到的事实**决定行为，不按机理写结论。

## Decision

**会话在跑的时候，回复走 `steer()`；空闲的时候走 `followup()`。**

harness 对"运行中收到人的输入"给的就是另一条路：

> `steer(message)`：Submit steering for the nearest step. An idle driver starts a turn; **a running driver consumes it at its next step boundary.**

这也正是桌面 composer 的行为：**agent 在工作时你打字，那句话是插进当前这一轮，而不是排到下一轮。**
手机上的回复是同一件事——一个正在跑的人说"先别改那个文件"，他期望的是**那一次运行改掉方向**，不是等它
跑完再开一轮。

分支条件用**会话状态**，不是"steer 存不存在"：一轮跑完的答复才是读者正在回应的东西，接下来该是**新的一轮**，
不是对已经结束的工作的修正。

`agent.steer` 不存在的部署（更老的 harness）保留原来的 `followup`：那是这次之前每一个版本走的路，
**拒绝发送比它要避免的风险更糟**。

## Consequences

- **插话会出现在当前那一轮的记录里**，不是自己的一轮。这是"steer"的本义，也是 composer 的行为。
- 发送路径现在**分岔**，所以它自己说清楚走的是哪条：一条 `log.info`（`已把手机上的指令排入会话` /
  `已把手机上的指令作为 steer 送进当前这一轮`），调试模式下还有一条诊断，带消息 id。
  这也是这条修复在真机上可验证的方式。
- **机理仍未证死**：我们改的是"走哪条路能到"，不是"为什么那条路不到"。如果以后有人拿到 harness 侧的确凿
  解释（是 inbox 的收回，还是 `claim` 之后没开轮），这份记录应该补上——那时也许 `followup` 本身可以修。

## Alternatives

**等会话空闲再投递**（轮询 `agent.status`，或 `whenIdle()` 之后再 `followup`）。否决：它把"我说了一句"
变成"它跑完才轮到我"，而人在手机上说这句话时，往往就是要**现在**改方向。而且它同样要依赖一个未被证明
会兑现的排队行为。

**两条路都试**（先 steer，失败再 followup）。否决：两条路都会"成功返回"（都是同步的 void 方法），
没有可判定的失败信号，双写反而可能让一条指令进两次。

## What would reopen this

- 真机上出现**一条指令进了两次**（正脸里同一句话出现两遍，或模型对同一句话回应两次）。
- 真机上出现 steer 之后当前那一轮的记录把它标成"插话"而读者读不懂（那要考虑在折叠里单独标出来）。
- 拿到确凿的 harness 侧解释，说明 `followup` 排队丢失是可修的——那时先修它，再简化这里的分岔。
