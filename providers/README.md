# 通道契约（Channel contract）

`pocket-console` 的核心只负责：两条 answerer seam、升级计时器、待决注册表、决策解码，
以及设置命名空间和浏览器卡片调用的同源路由。
**消息怎么送到手机上、按钮怎么点回来，全部由通道模块负责。**
换通道 = 新增一个模块 + 改 `channel` 配置项，**不需要改核心**。

## 模块形状

通道模块是一个 ESM 文件，导出：

```js
export async function create({ ctx, config, binding, log }) {
  return channel
}
```

| 入参 | 说明 |
|---|---|
| `ctx` | Host context。需要 `credentials` 时可自行解析凭据。 |
| `config` | `channelConfig` 原样透传，**由通道自己解释与校验**（字段集因通道而异）。 |
| `binding` | 接收人持久化：`{ read(): Promise<string\|undefined>, write(id): Promise<void>, clear(): Promise<void> }`。底层是本插件的凭据记录，跨重启保留。通道若不需要可忽略。 |
| `log` | `{ info(message), warn(message, error) }`。 |

## channel 对象

| 成员 | 必需 | 说明 |
|---|---|---|
| `available()` | 否 | 当前能否投递。返回 `false` 时核心**不挂计时器、不升级**，桌面链路保持权威。缺省视为始终可用。 |
| `supportsForms` | 是 | 能否渲染表单并回传多选/自由文本。`false` 时核心只升级"全是单选选项"的提问，其余留给桌面。 |
| `deliver(view)` | 是 | 投递一条消息，resolve 出不透明句柄（供 `update` 使用）。失败请抛错——核心会记警告并回落到桌面。 |
| `update(handle, view)` | 否 | 用新视图替换已投递的消息。缺失时决策后不回报结果。 |
| `subscribe(onAction)` | 是 | 订阅用户操作。返回取消订阅的函数。 |
| `close()` | 否 | 释放传输资源。 |

### 上手（enrollment，均为可选）

需要"扫码绑定"这类一次性上手的通道额外实现这三个成员；不需要上手的通道
（例如一个固定的 webhook URL）全部省略即可。

| 成员 | 说明 |
|---|---|
| `enrollmentState()` | 同步返回当前状态：`{ state: 'unbound' \| 'starting' \| 'awaiting' \| 'bound' \| 'failed', recipient?, verifyUrl?, expiresIn?, message? }`。**不得包含任何密钥。** |
| `beginEnrollment()` | 启动上手流程。必须**幂等**：设备授权轮询会比触发它的 HTTP 请求活得更久，进行中的那一轮要共享而不是每次重启。同步返回当前状态。 |
| `clearEnrollment()` | 撤销绑定与凭据，回到 `unbound`。 |

核心不会自动启动上手，除非 `webServer` 缺席——那时没有卡片可以询问，
核心会直接调用 `beginEnrollment()` 并把链接打进日志。
**有界面时由用户在设置卡片里点按钮触发。**

## 视图（核心 → 通道）

```js
{
  title: string,
  tone: 'warning' | 'info' | 'success' | 'danger' | 'muted',
  body: string[],            // 每项一个文本块
  buttons: [{ payload, label, tone: 'default' | 'primary' | 'danger' }],
  forms: [{
    payload,                 // 提交时原样回传
    fieldId,                 // 提交值到达 onAction(values) 时使用的键
    options?,                // {label, value}[]；缺省渲染自由文本输入
    multiSelect: boolean,
    submitLabel: string,
  }],
}
```

## 操作（通道 → 核心）

通道必须把 `payload` **原样**回传：

```js
onAction({ payload, values, messageId })
```

- `payload`：用户按下的按钮所携带的 `payload`。
- `values`：表单提交值，形如 `{ [fieldId]: string | string[] }`；非表单按钮时为 `undefined`。
- `messageId`：通道自己的消息句柄，核心不用，供通道实现 `update` 时关联。

返回值是 `{ toast, accepted }`，通道可据此给用户即时反馈（飞书里映射为 toast 弹窗）。

## 安全性要求

核心已经做了这件事：`payload.rid` 一次性随机、结算后立即失效、
选项必须来自该问题自己提供的标签。
**通道的责任是**：不要自行解释或改写 `payload`，不要在没有用户交互时伪造 `onAction` 调用。

## 现有通道

| 模块 | 传输 | 上手方式 |
|---|---|---|
| `feishu.js` | 飞书长连接（WebSocket），只需出网 | **扫码一键创建应用**（OAuth 2.0 Device Authorization Grant），凭据与接收人自动落到凭据库 |

### 未来通道的候选

| 通道 | 出网即可 | 能否回传 | 备注 |
|---|---|---|---|
| Telegram Bot | ✅ `getUpdates` 长轮询 | ✅ 内联键盘 | `deliver` 发消息，`subscribe` 轮询回调 |
| ntfy | 需手机能访问服务 | ✅ `X-Actions` 按钮 | 按钮可直连核心自建的小 HTTP 端点 |
| 企业微信 / 钉钉 | ✅ 长连接 | ✅ 交互卡片 | 与飞书同构，可直接照 `feishu.js` 改写 |
| Bark / Server酱 | ✅ | ❌ 只推不收 | `supportsForms: false`，只能做通知 |
