# 飞书卡片限制：平台边界、官方原话，与我们的余量

这份文档只回答一个问题：**飞书对卡片的每一处限制是多少，超了会怎样**。它存在的理由与
[`card-map.md`](card-map.md) 不同——那张图讲"我们发什么卡"，这份讲"平台允许我们发什么"。

起因是两件事的自证：一张 9 个表格的回答**整卡被拒且读者看不到任何东西**（
[#74](https://github.com/picsky/dsh-pocket-console/issues/74)），以及手机回复框在长 prompt 上**输不进去**
（`input.max_length` 上限 1000）。两件都不是"判据写错了"，而是**平台边界从没被记录下来**：
`budget.js` 守的是自己量出来的字节预算，而平台还有元素数、表格数、字段长度、回调时限这些**另一维度的闸门**，
它们不在字节预算里，撞上时同样表现为"没有卡片"。

## 标注规则（每条都必须带一个）

| 标注 | 含义 |
|---|---|
| **[文档]** | 官方文档或官方仓库原话，出处在文末 |
| **[实测]** | 本仓库在真实租户上量过（出处在 [boundaries.md](boundaries.md)），或本地对着 SDK 源码核过 |
| **[未证]** | 第三方报告互证、但官方无表述 |
| **[未定]** | 没查到也没量过，**不允许当已知数用** |

**一条纪律**：文档值与实测值冲突时**两个都写**，并说明哪个更硬。这个仓库已经吃过一次教训——
官方说卡片 30 KB，实测 131 KB 通过（§8）。

---

## 0. 最要紧的八条

| # | 限制 | 数值 | 超限后果 | 标注 |
|---|---|---|---|---|
| 1 | 单卡元素/组件数 | **≤ 200**（组件与元素**数量之和**，含嵌套） | 整卡被拒：`230099` + `element exceeds the limit`；cardkit 侧 `300305` | [文档] [实测] |
| 2 | 单卡表格数（**含折叠里的表，与分布在几个元素里无关**） | **实测硬顶 5**：5 张通过、6 张被拒 | 整卡被拒：`230099` + `card table number over limit` | [实测] [文档] |
| 3 | 单个 Markdown 元素里的表格 | 文档写 **≤4 个**；**实测既不拒卡、也不截断**（一个元素 5 张全部显示）；每表除表头最多 5 行（超出分页） | 无——文档那条不生效 | [文档] [实测] |
| 4 | 输入框可容字符数 | **`max_length` 默认 1000，上限就是 1000**（1.0 / 2.0 无差异） | 客户端**报错提示**（不是静默截断） | [文档] |
| 5 | 卡片请求体 | 官方 **30 KB**；实测 **131 KB 通过、164 KB 被拒**（`patch` 98 KB 通过） | 整卡被拒：`230025` / `200860` | [文档] [实测] |
| 6 | 回调应答 | **3 秒内**必须应答，**不许 3xx 重定向**；**SDK 不会替你抢答** | 客户端报交互错误（`200341`） | [文档] [实测] |
| 7 | 更新已发卡片 | 单条消息 **5 QPS**；只能改 **14 天内**、未撤回的 `interactive` 消息；且**只能由发送方应用改** | `230020` 限频 / `230031` 超期 / `200310` 非本人 | [文档] [实测] |
| 8 | 长连接 | 每应用**最多 50 条**；**集群模式不广播**（多客户端只有随机一个收到）；事件失败重试 **15 秒 → 5 分 → 1 时 → 6 时**（最多 4 次） | 事件丢失 / 收不到回调 | [文档] |

**共同后果值得单独说**：1、2、3、5 撞上时**整张卡被拒**，而平台**不给读者任何提示**——
手机上就是"这条消息不存在"，插件侧只有一行 `log.warn`。所以这些不是"显示难看"，是**静默丢失**
（第三方三份独立日志互证客户端无提示，官方文档对此无表述：`[未证]`）。

---

## 不漏发：对限制的立场（2026-09-26 定为不可协商的一条）

**限制只允许改变"卡看起来怎样"，不允许改变"卡有没有发出去"。** 本该发卡却收不到是事故；显示不全、
格式不严格遵守规范，都可以接受。落到代码里是六条：

| # | 规则 | 含义 |
|---|---|---|
| 1 | **每个闸门都要有降级路** | 元素多 → 丢折叠；表格多 → 表格转文本；字节多 → 砍正文；字段过长 → 截断并说明。**不允许"超限即整卡被拒"** |
| 2 | **降级先丢结构，再丢内容** | 折叠面板、对齐、边框先让位；正文里的信息最后才动，动了必须明说省略了多少（现有 `truncated` 文案就是这条） |
| 3 | **预算是预防，不是判据** | 主动按平台阈值留余量（`CARD_*`），而不是等被拒了再猜哪里超了 |
| 4 | **投递失败必须可观测** | 最终失败要进 `diagnostics()`，带上平台的 `code` / `msg`。只写一行 `log.warn` 不算（[#74](https://github.com/picsky/dsh-pocket-console/issues/74) 的教训） |
| 5 | **判据必须认得出真正的拒收** | 按错误码与子码分派降级类型，不能用一个措辞正则糊过去（§7.1 已查实三个码根本不是体积码） |
| 6 | **宁可发一张降级的卡，不可少发一张** | 读者看不到的失败等于事故；"静默"是最坏的结果，比"难看"坏得多 |

这条立场贯穿 §7.1 的判据修正、§10 的预算、以及 [#74](https://github.com/picsky/dsh-pocket-console/issues/74) 的修法。

---

## 1. 整卡与请求体

| 项 | 限制 | 标注 |
|---|---|---|
| 元素/组件总数 | **≤ 200**，措辞是"组件和元素的数量**之和**"；`tag: plain_text` 的文本元素也算 | [文档] |
| 嵌套是否计入 | 官方只有"之和"的间接表述，**没有一句显式说明**；按字面应计入 | [文档·推断] |
| `header` 是否计入 200 | **未定** | [未定] |
| 超限错误 | `230099` 子码 `11310`：`element exceeds the limit`；cardkit：`300305` | [文档] |
| `element_id` | 全卡唯一；**仅 `[A-Za-z0-9_]`，字母开头，≤ 20 字符**；重复 → `300301` | [文档] |
| 卡片体积 | `im.message.create`/`patch` 卡片消息 **≤ 30 KB**（纯文本 150 KB）；用模板时**含模板数据**；**样式标签会让实际体长大于请求体** | [文档] |
| 体积（实测） | **131 KB 通过、164 KB 被拒**（`230025`）；`patch` 实测 98 KB 通过 | [实测] |
| 体积超限错误 | `200860`（cardkit，建议"控制在 30 KB 以内"） | [文档] |
| cardkit `data` 字段校验 | 1 ～ 3,000,000 字符（**参数长度校验，不是语义上限**，别据此放宽预算） | [文档] |
| `config.update_multi` | 2.0 **只支持 `true`**；`patch` **前后都要显式声明**；cardkit 不接受 `false`（`300302`） | [文档] |
| `config.width_mode` | `default`（PC 上限 600px）/ `compact`（400px）/ `fill` | [文档] |
| 客户端版本 | 2.0 需 **≥ 7.20**：**低于 7.20 时标题正常、正文显示"请升级"兜底文案**（静默降级）；表格组件需 ≥ 7.4；错误码展示需 ≥ 7.28 | [文档] |
| 发送幂等 `uuid` | ≤ 50 字符；**同一 uuid 1 小时内至多成功发送一条** | [文档] |
| 正文长度（实测） | 中文 51,000 字通过 / 51,300 被拒；拉丁 120,000 / 200,000；emoji 20,000 / 40,000（量的是**解码后内容**，各类字符阈值不同） | [实测] |
| 1.0 的元素数上限 | **文档未记载** | [未定] |
| 1.0 是否废弃 | **没找到废弃公告**；不写 `schema` 默认按 1.0 渲染；1.0 **不支持 Markdown 表格** | [文档] |

---

## 2. 文本与 Markdown

| 项 | 限制 | 标注 |
|---|---|---|
| `markdown.content` 字符数 | **文档没给上限**（我们按自己的 32 KB 字节预算管） | [未定] |
| `plain_text.content` 字符数 | **文档没给上限** | [未定] |
| **Markdown 表格（卡里真正的闸门）** | **整卡 5 张**：实测 5 张通过、6 张被拒；**与"分成几个元素"无关**（3+3 被拒），**折叠面板里的表同样计入**（正文 3 + 折叠 3 被拒）。见 §11 | [实测] |
| Markdown 表格（文档写的单组件上限） | 文档：单个富文本组件 **≤4 张**。**实测既不拒卡也不截断**：一个元素 5 张照样通过，且**五张全部显示**（2026-09-26 使用者目视）⇒ 这条文档值在服务端与客户端**都不生效** | [文档] [实测] |
| 每张表的数据行 | 除表头**最多展示 5 行**，超出分页（显示层，不拒卡）；**仅 2.0 支持表格语法** | [文档] |
| Markdown 表与 `table` 组件是否共用同一个 5 | **未定**（本插件不用 `table` 组件，暂不影响；§9 L11） | [未定] |
| Markdown 特殊字符 | 要**按字面**显示 `* ~ > < [ ] ( ) # : _` 必须 HTML 转义（如 `<`→`&#60;`） | [文档] |
| 加粗 | 前后留空格更稳；**不要连续 4 个 `*` 或 `_`** | [文档] |
| `header.title` | 最多 **4 行**；无硬字符上限（实测 144 显示列仍 `code=0`，视觉截断点在 87～144 列之间） | [文档] [实测] |
| `header.subtitle` | 最多 **1 行**（不跨行，超出由平台截断）；**必须是对象**，裸字符串 → `230099`；实测 182 显示列仍 `code=0` | [文档] [实测] |
| `header.text_tag_list` | 最多 **3 个**，超出取前 3 | [文档] |
| `div.text.lines` | 可设最大显示行数，超出 `...` 省略 | [文档] |
| 按钮文字 | `text.content` **≤ 100 字符** | [文档] |
| `overflow` 选项文字 | `options[].text.content` **≤ 100 字符** | [文档] |
| 输入框占位 | `placeholder.content` **≤ 100 字符** | [文档] |
| `label` / 下拉选项文本长度 | **未定** | [未定] |
| 列表缩进 | 4 个空格一层 | [文档] |

---

## 3. 交互组件

### 3.1 输入框 `input`（**手机回复框就是它，用户踩到的就是这一条**）

| 字段 | 默认 | 取值/限制 | 标注 |
|---|---|---|---|
| `max_length` | **1000** | **整数 [1, 1000]** ——**无法调高**（1.0 与 2.0 相同） | [文档] |
| 超出 `max_length` | — | **组件报错提示**（官方原话："当用户输入的文本字符数超过最大文本长度，组件将报错提示"） | [文档] |
| `input_type` | `text` | `text` / **`multiline_text`**（多行，回调值含 `\n`）/ `password` | [文档] |
| `rows` / `auto_resize` / `max_rows` | 5 / false / 空 | `auto_resize` 与 `max_rows` **仅 PC 生效** | [文档] |
| `name` | — | **在 `form` 内必填且全卡唯一**；为空 → 回调错误 `200530` | [文档] |
| `placeholder` | — | plain_text，**≤ 100 字符** | [文档] |
| `width` | `default` | `default` / `fill` / `[100,∞)px` | [文档] |
| 回调 | — | 独立时 `action.tag="input"` + `action.input_value`；**在 form 内则值在 `form_value`** | [文档] |

**换句话说**：手机侧一条消息能交给 agent 的指令**最多 1000 个字符**，这是平台硬顶，改不了。
插件的文字预算是 32 KB（≈11,000 汉字），**在输入框这条路上永远用不到**——闸门在更前面。

**我们的做法**（2026-09-26 修，[0035](../docs/decisions/0035-the-instruction-box-says-what-it-holds.md)）：两个 `input` 都发
`input_type: 'multiline_text'` + `rows: 3` + **显式** `max_length: 1000`；三个 placeholder（回答 / 补充说明 / 新会话）
都写明"最多 1000 字"。取 3 行而不是文档默认的 5 行，是因为结果卡上同时有**两个**这样的框；`auto_resize` /
`max_rows` 不发（只在 PC 生效，而这个卡是给手机看的）。placeholder 本身有 **≤100 字符**的上限，
所以"写明上限"这句话也要被守住——有单测逐个量它的字符数。

### 3.2 其他交互组件

| 组件 | 限制 | 标注 |
|---|---|---|
| `checker` | `button_area.buttons` **≤ 3 个**；不配 `behaviors` **不会回调**（只本地勾选） | [文档] |
| `button` | `behaviors[].value` 即回传值；**类型必须是 Object**（Node SDK 不支持字符串类型）；表单内按钮不用 `behaviors`，改用 `form_action_type` | [文档] |
| `select_static` / `multi_select_*` / `person` 系 / `overflow` / picker | 选中即默认回调；同一组件内 option `value` 必须唯一 | [文档] |
| 选项数量上限 | **未定**（只查到 checker 的按钮 ≤3） | [未定] |
| `form` | **只能放卡片根节点**，不能被别的组件嵌套；子节点**不能是 `table`/`form`**；**必须有一个 `form_action_type: "submit"` 的按钮**；内部交互组件 `name` 必填且**全卡唯一** | [文档] |
| 每卡几个 `form` / 每卡几个按钮 | **未定** | [未定] |
| `button.value` / `form_value` 的最大字节数 | **官方无任何上限或截断声明**；唯一间接约束是整卡 30 KB | [未定] |

---

## 4. 容器与嵌套

| 容器 | 限制 | 标注 |
|---|---|---|
| **所有容器** | **最多嵌套 5 层**（各容器文档统一表述） | [文档] |
| `column_set` / `column` | 直接子节点**只能是 `column`**（二级分栏走 `column_set → column → column_set`）；`column` 内**不能放 `form`/`table`**；`weight` 1~5；`width` [16,600]px | [文档] |
| `column_set` 的列数上限 | **未定**（只有 `bisect`=2、`trisect`=3 的语义） | [未定] |
| `collapsible_panel` | **不支持 `form`**（[文档] [实测] 一致）；能否含 `table`：官方 2.0 文档未排除，官方仓库 skill 的表述与之冲突 → **未定** | [未定] |
| `interactive_container` | 不能含 `form`/`table`；可以嵌自身 | [文档] |
| `table`（组件） | **只能放 `body` 根节点**，不可被嵌套、自身不可嵌别的组件；**≤ 50 列**（超出不展示）；`page_size` [1,10]；`row_height` [32,124]px 或枚举；`row_max_height` [32,999]px；列宽 [80,600]px 或 [1%,100%] | [文档] |
| 单元格文本长度 | **未定**（只有"不可过长，否则显示不完整"的定性表述） | [未定] |
| 图片 | 上传 **≤ 10 MB**、**≤ 1500×3000px**、**高:宽 ≤ 16:9** | [文档] |
| `chart` | 单卡**建议 ≤ 5 个**（建议，非硬限）；`height` `auto` 或 [1,999]px | [文档] |
| 元素总数 | 以上嵌套子元素**全部计入**那 200（推断） | [文档·推断] |

---

## 5. 回调、更新、发送与配额

### 5.1 卡片回调

| 项 | 数值 | 标注 |
|---|---|---|
| 应答时限 | **3 秒**；**不可用 HTTP 3xx**；只回 HTTP 200 + `{}` / `toast` 也算完整应答 | [文档] |
| 超时错误 | `200341`（回调服务未在规定时间内响应）；非 200 → `200671` | [文档] |
| **SDK 是否自动抢答** | **不会**。`@larksuiteoapi/node-sdk@1.74.0` 的 `handleEventData` 会 `await eventDispatcher.invoke(...)`，**handler 返回后**才写回应答帧；**handler 的全部执行时间都算在这 3 秒里** | [实测] |
| 回调是否重推 | **不重推**（回调是同步操作，与事件不同） | [文档] |
| 回调响应里带 `token` 的延时更新 | 有效期 **30 分钟**，**最多 2 次**；**必须在响应回调之后**执行；**必须传完整卡片 JSON**（不支持局部更新） | [文档] |
| 交互有效期 | 2.0：回传交互与可更新**统一 14 天**；1.0：交互 30 天、可更新 14 天 | [文档] |
| 回调权限 | 订阅 `card.action.trigger` **暂无额外权限**；后台**必须启用回调配置**，否则收不到且无 preflight 报错（`200340`） | [文档] |
| 表单提交的回调形状 | `action.tag` 仍是 `button`，靠 `form_value` 非空区分（**没有 `form_submit`**） | [文档] |

### 5.2 更新已发卡片

| 项 | 数值 | 标注 |
|---|---|---|
| `im.message.patch` | 单条消息 **5 QPS**；接口级 1000 次/分 & 50 次/秒 | [文档] |
| 可更新窗口 | 发送后 **14 天内**（超期 `230031`）；已撤回 `230011`、已删除 `230110` | [文档] |
| 身份限制 | **只能由发送卡片的那个应用更新**（`200310`）；user token 不支持 | [文档] |
| 不支持更新 | 批量发送的消息、仅特定人可见的卡片 | [文档] |
| cardkit 路径 | `card.update` / `settings` / `batch_update` / 组件级：**每卡片实体 10 次/秒**，另有 1000 次/分 & 50 次/秒的接口级限制；`sequence` **必填且严格递增**（否则 `300317`）；卡片实体有效期 14 天，**只能发送一次** | [文档] |
| 流式模式 | `streaming_mode: true` 期间**不触发接口 QPS 限频**；距上次开启 **10 分钟自动关闭**；**流式期间不能走交互回调更新**（`200810`）；流式卡片不能转发 | [文档] |
| "正在交互中不可更新" | 子码 `11310` 的 `card action is lock`（**与 `200810` 是两回事**） | [文档] |
| 编辑已发卡片是静默的 | 不响、不产生新消息、列表预览不变（活动卡成立的全部原因） | [实测] |
| `patch` 能改 `subtitle`（晚到的会话名补得上） | 已验证 | [实测] |
| 置顶卡仍可 `patch` | 已验证 | [实测] |

### 5.3 发送与幂等

| 项 | 数值 | 标注 |
|---|---|---|
| 同一用户限频 | **5 QPS** | [文档] |
| 同一群组限频 | **5 QPS**（群内机器人**共享**） | [文档] |
| 接口级 | 1000 次/分 & 50 次/秒 | [文档] |
| 消息 `uuid` | ≤ 50 字符；同 uuid **1 小时内至多成功一条** | [文档] |
| 自定义机器人（Webhook） | 单租户单机器人 **100 次/分、5 次/秒**；官方建议避开 10:00、17:30 等整点（否则 `11232`） | [文档] |
| 每窗口最多发几条 | **未定**（只有 5 QPS 速率，没有绝对条数） | [未定] |

### 5.4 长连接与事件订阅

| 项 | 数值 | 标注 |
|---|---|---|
| 每应用最大长连接数 | **50**（每初始化一个 client 算一条）；超限 SDK 常量 `1000040350` | [文档] [实测] |
| 单帧处理时限 | **3 秒**内处理完成且不抛异常，否则触发超时重推 | [文档] |
| 推送模式 | **集群模式、不广播**：同一应用多个客户端只有**随机一个**收到 | [文档] |
| 事件重试 | 失败后 **15 秒 → 5 分钟 → 1 小时 → 6 小时**，**最多 4 次**（约 6 小时） | [文档] |
| 去重 | 至少一次投递，**必须幂等**。通用 2.0 事件用 `event_id`；**但 `im.message.receive_v1` 自己的文档要求用 `message_id` 去重，并明写"不要依赖 `event_id`"**；SDK 侧不做任何内置去重 | [文档] |
| 到达顺序 | **不能假定有序**：官方只对"部分事件"用有序推送，而 `im.message.receive_v1` 页面**没有**有序标注 | [文档] |
| 编辑 / 撤回 | **编辑消息不产生任何事件**；撤回有独立事件 `im.message.recalled_v1`（`recall_type`：`message_owner` / `group_owner` / `group_manager` / `enterprise_manager`） | [实测] |
| 引用回复的锚点 | 用户「回复」某条消息时，`message.parent_id` = **被回复那条消息的 `message_id`**（`root_id` = 树根）；**事件里只有 ID，没有被引用消息的正文**（读正文需额外的 `im:message:readonly`） | [文档] |
| 有序事件 | 部分事件有序：前一条成功接收后才推下一条；阻塞会让后续进入重试队列 | [文档] |
| 订阅类型限制 | 仅**企业自建应用**；旧版 `card.action.trigger_v1` **不支持长连接**（只能 Webhook） | [文档] |
| SDK 默认心跳/重连 | ping **120 秒**；重连固定 **120 秒** + 0~30 秒抖动；重试次数 **-1（无限）** | [实测] |

### 5.5 频控

| 项 | 数值 | 标注 |
|---|---|---|
| 触发后的响应 | HTTP **429**（部分旧接口 400），`code=99991400`，响应头 `x-ogw-ratelimit-limit` / `x-ogw-ratelimit-reset`（建议等待秒数）；接口内码 `230020` | [文档] |
| 维度 | 通常 **每 API × 每应用 × 每租户**；达到 QPS **或** QPM 任一上限即触发 | [文档] |
| 等级表（节选） | 等级4 = 1000 次/分 & 50 次/秒；等级7 = 10 次/秒；等级11 = 100 次/秒 | [文档] |

---

## 6. 错误码字典（卡片被拒时到底发生了什么）

**`230099` 是个信封，不是原因**。只看外层码会把"表格超限"和"元素超限"混为一谈——这正是
[#74](https://github.com/picsky/dsh-pocket-console/issues/74) 里 `looksLikeSizeRefusal()` 判错的那一步。

| 码 | 含义 | 能做什么 | 标注 |
|---|---|---|---|
| `230020` | **触发频率限制** | 退避重试（照 `x-ogw-ratelimit-reset`） | [文档] |
| `230022` | 内容含敏感信息 | 不可重试 | [文档] |
| `230025` | **消息体长度超限**（卡片/富文本 30 KB、纯文本 150 KB） | 砍体积后重投 | [文档] |
| `230002` | **机器人不在对应群组中** | 不可重试 | [文档] |
| `10002` | **机器人不在会话中**（cardkit 下同名码另指"参数错误"） | 不可重试 | [文档] |
| `230013` | 用户不在应用可用范围 / 被禁用 / 已离职 | 不可重试 | [文档] |
| `230027` | 权限不足（含外部群未开对外共享） | 不可重试 | [文档] |
| `230028` | 数据防泄漏审查未通过（明文手机号/邮箱等） | 改内容 | [文档] |
| `232009` | 群已解散 | 不可重试 | [文档] |
| `230031` | **超过 14 天，不可再更新** | 重发新卡 | [文档] |
| `230011` / `230110` | 消息已撤回 / 已删除 | 不可重试 | [文档] |
| `230099` | 卡片内容创建失败（总括码，看子码） | **按子码分派** | [文档] |
| └ `11310` `element exceeds the limit` | 超过 200 个组件/元素 | 减元素（优先丢折叠） | [文档] |
| └ `11310` `card action is lock` | 卡片正在交互中，无法更新 | 稍后重试 / 不重试 | [文档] |
| └ `11310` **`card table number over limit`** | **表格数超限（整卡 >5）。不在官方子错误码表里**（该表 15 条无此条），但真实存在：本租户 2026-09-26 实测（§11）+ 三份第三方日志互证 | 表格降级为文本 | [实测] [未证] |
| └ `100290` | 卡片里有无效的人员 id | 不可重试 | [文档] |
| └ `200380` / `200381` | 模板不存在 / 无使用权限 | 不可重试 | [文档] |
| └ `200621` | 卡片 JSON 格式错误 | 不可重试 | [文档] |
| └ `200732` / `200737` | 模板变量类型/格式错误 | 不可重试 | [文档] |
| └ `200550` | `chart_spec` 非法 | 不可重试 | [文档] |
| └ `200570` | 图片 `img_key` 无效 | 不可重试 | [文档] |
| └ `200861` | 用了 2.0 已废弃的 tag | 不可重试 | [文档] |
| └ `200914` / `200915` | 表格行无效 / 行名未在列中声明 | 不可重试 | [文档] |
| `300305` | 组件数超 200（cardkit 侧说法） | 同 `11310` | [文档] |
| `300301` | `element_id` 重复 | 渲染时保证唯一 | [文档] |
| `300302` / `300311` | cardkit 不接受 `update_multi:false` / 非创建应用操作卡片实体 | 不可重试 | [文档] |
| `300317` | `sequence` 未严格递增 | 修正序号 | [文档] |
| `200860` | 卡片体积超限（cardkit 侧说法） | 砍体积 | [文档] |
| `200810` | 卡片处于流式/交互中无法更新 | 先关流式 | [文档] |
| `200750` | 卡片实体超 14 天，需重建 | 重发 | [文档] |
| `200770` | `uuid` 重复 | 换 uuid | [文档] |
| 回调侧 `200340`～`200343` | 回调地址未配置 / **3 秒内未响应** / TCP 失败 / DNS 失败 | 只影响回调 | [文档] |
| 回调侧 `200530` | 表单内组件 `name` 为空 | 渲染时保证 | [文档] |
| 回调侧 `200672` / `200673` | 回调响应体 / 卡片格式错误 | 只影响回调 | [文档] |

**读者可见性**：发送方能看到 HTTP 400 与 `msg`（内含 `ext=ErrCode:…; ErrMsg:…; ErrorValue:…`，并给出
`log_id` 与排查 URL）**[文档]**；**客户端（接收方）官方文档没有任何描述**，第三方日志一致称**完全无提示**
**[未证]**。⇒ 只能靠发送侧自己观测，不能指望读者报告。

---

## 7. 我们现在的余量（逐条对照）

| 限制 | 平台 | 我们 | 状态 |
|---|---|---|---|
| 元素数 | 200 | `CARD_ELEMENT_BUDGET = 120`（结果卡折叠的块数按它分配）；实测 180 通过 / 200 被拒 | ✅ 有余量 |
| 卡片请求体 | 官方 30 KB / 实测 131 KB 通过 | `CARD_BODY_BUDGET = 96 KB`（`fitCard()` 兜底：先丢折叠，再按比例缩短） | ✅ 取舍已记录 |
| 文字字节 | 中文≈51,000 字被拒 | `CARD_TEXT_BUDGET = 32 KB` | ✅ |
| 更新频率 | 单消息 5 QPS | 活动卡 `REFRESH_MS = 250` → 正常路径最多 4 次/秒（最坏 8 次/秒只在"体积被拒后半长重投"那次） | ⚠️ 见 [review-2026-09.md](review-2026-09.md) R11 |
| `update_multi` | 2.0 只能 `true`、`patch` 前后都要声明 | 已设 `true` | ✅ |
| 回调 3 秒 | 3 秒，SDK 不抢答 | `handleAction` **只 await 一次动态 import + 一次同步交接**，卡片改写**刻意不等**（`results.js:1138-1145` 写明了这个代价） | ✅ 已按预算设计 |
| 长连接 | ≤50 条、不广播、3 秒处理 | 单实例一条连接；**事件重推未按 `event_id` 去重，但唯一副作用是"绑定接收人"，它本身幂等**（`providers/feishu.js:519-546`：已绑定同一人直接 return） | ✅ 已核对 |
| **表格数** | **实测整卡 5 张**（含折叠里的表；与分成几个元素无关） | `CARD_TABLE_BUDGET = 4`，渲染时**跨正文与折叠共用一个计数器**，超出的表**写成文本**；平台仍拒收时把表格全部转文本重投一次 | ✅ 已修（[0031](../docs/decisions/0031-a-limit-changes-the-card-never-whether-it-arrives.md)、[#96](https://github.com/picsky/dsh-pocket-console/issues/96)） |
| **投递最终失败** | 平台拒收时读者什么都收不到（静默） | 按拒收类型降级后仍失败 → 结果卡**退回发一条纯文本消息**（无元素/表格/30 KB 闸门）；失败原因进 `diagnostics`，带平台 `code`/`msg` | ✅ 已修（同上） |
| **输入框长度** | **≤1000 字符**，超出客户端报错 | `INPUT_MAX_LENGTH = 1000` **显式写出**；两个框都是 `multiline_text`、`rows: 3`；三个 placeholder（中英各三）都写明上限 | ✅ 已修（[0035](../docs/decisions/0035-the-instruction-box-says-what-it-holds.md)、[#107](https://github.com/picsky/dsh-pocket-console/issues/107)） |
| Markdown 特殊字符转义 | 按字面显示需 HTML 转义 | 正文按 Markdown 原样送（有意），但会话名/标题里的 Markdown 字符未转义 | ⚠️ 未评估 |
| `header.subtitle` 1 行 | 超出由平台截断 | 已知取舍：名字不裁剪，交给平台截 | ✅ 已记录 |
| 图片/图表/表格组件 | 各自的列数、尺寸上限 | 本插件不用这些组件 | ✅ 不适用 |
| 客户端版本降级 | <7.20 只显示标题 + 升级提示 | 未评估（真机是桌面与新版手机） | ⚠️ 未评估 |

### 7.1 我们判据里已经查实的一处错误

`budget.js` 的 `SIZE_CODES = {230025, 230020, 230002, 10002}`——按官方文档逐个核对：

| 码 | 官方含义 | 在 `SIZE_CODES` 里对吗 |
|---|---|---|
| `230025` | 消息体长度超限 | ✅ 对 |
| `230020` | **触发频率限制** | ❌ 不是体积 |
| `230002` | **机器人不在对应群组中** | ❌ 不是体积 |
| `10002` | **机器人不在会话中**（cardkit 下另指参数错误） | ❌ 不是体积 |

即：**四个码里只有一个是体积码**；而真正会拒卡的 `230099`（+ 子码）**一个都没收**，措辞正则
`/size|too large|too long|too many bytes|length|exceed|payload/` 也匹配不到
`card table number over limit`（实测 `looksLikeSizeRefusal(...) === false`）。
后果：真的体积超限以外的失败会被当成体积超限去"砍半重投"，而真正该降级的表格超限**完全不降级**。

---

## 8. 文档值与实测值冲突清单（都留着，别只信一边）

| 项 | 官方文档 | 本仓库实测 | 结论 |
|---|---|---|---|
| 卡片请求体 | **30 KB**（`230025` 说明、`200860` "请控制在 30 KB 以内"） | **131 KB 通过、164 KB 被拒**；`patch` 98 KB 通过 | **文档是保守值**；按文档建预算会把卡片切碎（[boundaries.md](boundaries.md) §3） |
| 体积（官方自相矛盾） | 正文统一 30 KB；延时更新错误码 `100000` 又写"转换后超过 **100 KB**" | 131 KB 通过 | 以 30 KB 为文档值，以实测为准 |
| 元素数 | **200**（`300305`、`11310`） | **180 通过、200 被拒** | 两边一致：200 是硬顶 |
| 表格数 | **≤5/卡**（`table` 组件）；Markdown **≤4/组件** | **5 张通过、6 张被拒；一个元素里放 5 张也通过**（2026-09-26，§11） | 卡级 5 与文档一致；**"单组件 ≤4" 服务端不执行**——文档与实测冲突，以实测为准 |
| 输入框 `max_length` | 默认 1000、范围 [1,1000] | 用户真机撞到上限 | 一致 |
| 长连接能否收回调 | 官方《配置回调订阅方式》说可以；**Node SDK README 说"仅支持事件订阅，不支持回调订阅"** | 本插件长连接收回调已在真实租户跑通 | **README 那句过时** |

---

## 9. 还没证实的事（不要当已知数用）

| # | 问题 | 为什么重要 | 怎么量 |
|---|---|---|---|
| L1～L3 | **已在 2026-09-26 实测回答**：闸门是**整卡 5 张**、**折叠计入**、**"单组件 ≤4" 不拒卡** —— 见 §11 | — | — |
| L4 | `max_length` 超限时客户端**报错还是静默截断** | **不再卡住我们**：文案已经写明"最多 1000 字"，两种行为下这句话都对（[0035](../docs/decisions/0035-the-instruction-box-says-what-it-holds.md)）。想知道的是**读者会不会丢字**：静默截断会让"我写完了"变成假象 | 真机输 1001 字符 |
| L5 | `markdown.content` 本身有没有字符上限 | 我们的 32 KB 预算是否已在平台之上 | 单元素塞超长文本 |
| L6 | "交互中不可更新"（`card action is lock`）在我们的表单卡上会不会出现 | 影响"回复后原地改写"的可靠性 | 打开表单不提交，同时触发一次 `patch` |
| L7 | 事件重推（最多 4 次）会不会造成重复副作用 | 平台是"至少一次"投递；**当前只有一个事件处理器**（`im.message.receive_v1`），副作用是绑定接收人，已按"已绑定同一人就 return"实现成幂等（`providers/feishu.js:519-546`）；**残留**：两帧并发时是"读—写"而非原子比较交换（写的是同一个值，实践上无害），且**将来任何新事件处理器都必须自己保证幂等** | 新增事件处理器时按 `event_id` 去重 |
| L8 | 卡片实体路径（cardkit）是否需要 10 次/秒的按卡片节流 | 若将来改用 `card.update` 换掉 `patch` | 需要时再量 |
| L9 | 按钮 `value` / `form_value` 有无实际大小上限或截断 | 我们的回调 payload（`nid`、`submits` 映射）会不会被截 | 塞大 payload 实测 |
| L10 | ~~"单组件 ≤4 张表"是不是**渲染**规则~~ | **已回答**（2026-09-26 使用者目视探针 P3）：**五张全部显示** ⇒ 它连渲染规则都不是 | — |
| L11 | `table` 组件与 Markdown 表是否共用一个 5 的额度 | 本插件不用 `table` 组件，暂不影响；将来若改用组件则必须知道 | 1 个 Markdown 表 + 5 个 `table` 组件 → 被拒即共用 |

---

## 10. 工程建议的预算（**非文档值**，是取舍）

| 预算项 | 建议值 | 依据 |
|---|---|---|
| 单卡元素/组件总数（含嵌套） | **≤180** | 文档 200、实测 180 通过 / 200 拒绝，留客户端差异余量 |
| 单卡表格总数（Markdown 表 + 折叠里的表） | **≤4** | **实测硬顶是 5**（5 通过 / 6 被拒，§11）；与其它预算同一口径取在阈值之下 ⇒ 第 5 张起就降级 |
| 单个 Markdown 元素内表格 | **不需要单独设限** | 服务端不按单组件计数（一个元素 5 张通过，§11） |
| 单卡卡片 JSON 体积 | **≤24 KB**（30 KB × 0.8） | 官方明确"样式标签会使实际体长大于请求体" |
| 容器嵌套深度 | **≤5**（硬性） | 官方各容器文档 |
| 输入框可收字数 | **按 1000 规划**（已显式写成 `INPUT_MAX_LENGTH`），超出要走别的路：**卡片上写明上限**，长指令走聊天（[#98](https://github.com/picsky/dsh-pocket-console/issues/98)） | 官方 [1,1000] 硬顶 |
| 降级顺序（表格） | 表格 → 逐行文本（保留信息）→ 丢折叠 → 砍正文 | [#74](https://github.com/picsky/dsh-pocket-console/issues/74) 的建议修法；官方另提供 `post` 富文本 `md` 消息（支持 GFM 表格）作为"不放在卡里"的备选 |

---

## 11. 实测记录

### 2026-09-26 · 一张卡到底能放几张表

- **怎么量的**：本机部署（`dsh web` + 飞书自建应用 + 长连接），用**插件自己的应用与已绑定的接收人**，顺序发 5 张只含 Markdown 表的卡——无交互元素、无 `element_id`、各自一个新 `uuid`，因此不碰插件任何状态。工具是
  [`scripts/probe-card-limits.mjs`](../scripts/probe-card-limits.mjs)（`--send` 才真发，不带参数只打印计划）。
- **结果**：

| 探针 | 卡内表格分布 | 平台裁决 |
|---|---|---|
| P0 | 1 个元素 4 张 | **通过** |
| P1 | 正文 3 + 2 = **5** | **通过** |
| P2 | 正文 3 + 3 = **6** | **被拒**：`230099 / ErrCode: 11310 / ErrMsg: card table number over limit; ErrorValue: table;` |
| P3 | **1 个元素 5 张** | **通过** |
| P4 | 正文 3 + 折叠 3 = **6** | **被拒**（同上） |

- **读出来的三条**：① 闸门按**整卡**计数、阈值就是 **5**（5 通过、6 被拒）；P1 与 P2 的唯一差别是总数，所以"分成几个元素"不影响；② **折叠面板里的表计入同一个计数**（P4）；③ 官方"单个富文本组件最多 4 张"**既不被服务端执行、也不是截断规则**——P3 一个元素 5 张照样通过，且使用者 2026-09-26 目视确认**五张全部显示**（§9 L10 结）。
- **读者侧现场**：被拒的 P2、P4 **什么也没有到达**（手机上不存在这两张卡），通过的 P0、P1、P3 到了——这就是 [#74](https://github.com/picsky/dsh-pocket-console/issues/74) 那个"静默"的可复现现场。
- **错误对象形状**（对修法有用）：SDK 抛的是 axios 错误，`code` 在 `error.response.data.code`、文案在 `error.response.data.msg`，另带 `log_id` 与排查 URL。插件当时的 `looksLikeSizeRefusal()` 两条路都读到了，但**都不认**（§7.1）。

### 2026-09-26 · 修完之后的复验（同一租户）

把上面那张"必被拒"的卡（正文 9 张表 + 折叠 2 张）交给**修好后的渲染器**再发一次：

| 项 | 结果 |
|---|---|
| `CARD_TABLE_BUDGET` | 4 |
| 渲染后整卡表格数 | **4**（修复前是 11） |
| 降级上报 | `tables: 7`（7 张写成文本） |
| 第 6 张表 | 已转为文本（单元格 `a6 · b6` 仍在） |
| 第 1 张表 | 仍是表格 |
| **平台裁决** | **`code=0`（送达）** |

⇒ 同一张卡从"整卡被拒、读者什么都收不到"变成"送达，其中 7 张表以文本呈现"。修法见 [0031](../docs/decisions/0031-a-limit-changes-the-card-never-whether-it-arrives.md)。

---

## 出处

**官方文档（本文件所有 [文档] 标注）**

- [卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)（200 元素、`element_id`、`width_mode`、客户端 7.20）
- [卡片 JSON 2.0 版本更新说明](https://open.feishu.cn/document/feishu-cards/card-json-v2-breaking-changes-release-notes)（1.0/2.0 差异、废弃项）
- [输入框 input（2.0）](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input) / [（1.0）](https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/input)（`max_length` 1~1000、`input_type`）
- [富文本 Markdown](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)（表格 ≤4/组件、≤5 行/表、转义要求）
- [表格组件（2.0）](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table) / [（1.0）](https://open.feishu.cn/document/feishu-cards/card-components/content-components/table)（≤5/卡、≤50 列、只放根节点）
- [标题](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/title)、[按钮](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)、[勾选器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/checker)、[折叠按钮组](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/overflow)
- 容器：[分栏](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/column-set)、[表单](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)、[折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)、[交互容器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/interactive-container)（容器嵌套 ≤5 层）
- [发送消息 im.message.create](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)（5 QPS/用户、5 QPS/群、30 KB、`uuid`、错误码与 11310 子码）
- [更新消息 im.message.patch](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)（14 天、5 QPS/消息、30 KB、`230031`）
- [卡片回传交互](https://open.feishu.cn/document/feishu-cards/card-callback-communication)（3 秒、禁 3xx、`token` 30 分钟/2 次、回调错误码）
- [处理卡片回调](https://open.feishu.cn/document/feishu-cards/handle-card-callbacks) / [延时更新卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/delay-update-message-card)
- [频控策略](https://open.feishu.cn/document/ukTMukTMukTM/uUzN04SN3QjL1cDN)（429、`x-ogw-ratelimit-reset`、等级表、自定义机器人）
- [cardkit 创建卡片实体](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/create) / [card.update](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/update) / [settings](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/settings) / [batch_update](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/batch_update)（`300305`、`200860`、`sequence`、10 次/秒）
- [流式更新概览](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)（流式豁免 QPS、10 分钟自动关闭、`200810`）
- [使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) / [使用长连接接收回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address)（50 条连接、3 秒处理、集群模式）
- [事件概述](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)（重试 15 秒/5 分/1 时/6 时，最多 4 次；幂等要求）
- 官方 `larksuite/cli` 仓库的卡片组件参考（与本文件逐条对齐过）：<https://github.com/larksuite/cli/tree/main/skills/lark-im/references/card>

**本仓库的 [实测] 来源**

- [`internal/boundaries.md`](boundaries.md) §3 飞书（元素 200、正文长度、`subtitle`、置顶、回调 3 秒、`patch` 14 天/5 QPS）
- [`budget.js`](../budget.js) 顶部的实测上限表与 `CARD_*` 常量
- [`internal/card-map.md`](card-map.md) 的"一些数字"（活动卡 250 ms、各预算）
- [`results.js`](../results.js) `handleAction` 的 3 秒取舍注释
- [issue #74](https://github.com/picsky/dsh-pocket-console/issues/74)（9 张表格被拒的原始证据）
- 本地 `@larksuiteoapi/node-sdk@1.74.0` 源码（不自动应答、心跳 120 秒、无限重连）

**第三方（[未证]）**

- <https://github.com/larksuite/openclaw-lark/issues/53> —— 完整 `230099 / 11310 / card table number over limit` 响应体 + 客户端无提示
- <https://github.com/HKUDS/nanobot/issues/1382> —— 带 `log_id` 的真实运行日志
- <https://github.com/openclaw/openclaw/issues/43690> —— "fails silently，客户端收不到任何消息"

**维护规则**：任何一次真机实测（无论证实还是证伪）都要回来改这张表，写清是哪一天、怎么量的。
标 [未定] 的项在量到之前**不要**被写进代码注释当依据。
