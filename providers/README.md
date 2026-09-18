# Channel contract

The core of `pocket-console` owns: the two answerer seams, the escalation timer, the
pending registry, decision decoding, and the settings namespace with the same-origin routes
the browser card calls.
**How a message reaches the phone, and how a button press comes back, belongs entirely to
the channel module.**
Changing channel = adding one module + pointing the `channel` setting at it. **The core is
not touched.**

中文版：[docs/zh-CN/providers.md](../docs/zh-CN/providers.md)

## Shape of a module

A channel is one ESM file exporting:

```js
export async function create({ ctx, config, binding, log, messages }) {
  return channel
}
```

| Argument | Meaning |
|---|---|
| `ctx` | Host context. Resolve credentials from it yourself if the channel needs `credentials`. |
| `config` | `channelConfig` passed through verbatim. **The channel interprets and validates it** — the field set differs per transport. |
| `messages` | Reader for the card copy dictionary (`() => ({ … })`), which follows the deployment's `locale`. **Every reader-facing string comes from here**, including language-specific formatting (numbers, separators, punctuation). |
| `binding` | Recipient persistence: `{ read(): Promise<string\|undefined>, write(id): Promise<void>, clear(): Promise<void> }`. Backed by this plugin's credential record, so it survives a restart. A channel that does not need it may ignore it. |
| `log` | `{ info(message), warn(message, error), debug(message) }`. |

## The `channel` object

| Member | Required | Meaning |
|---|---|---|
| `available()` | no | Whether it can deliver right now. On `false` the core **arms no timer and does not escalate**, leaving the desktop chain authoritative. Absent means always available. |
| `supportsForms` | yes | Whether it can render forms and return multi-select answers or free text. On `false` the core escalates only questions that are *entirely single-select options*; anything else is left to the desktop. |
| `deliver(view)` | yes | Deliver one message, resolving to an opaque handle for `update`. **Throw on failure** — the core logs a warning and falls back to the desktop. |
| `update(handle, view)` | no | Replace an already-delivered message with a new view. Without it, a decision is not reported back to the card. |
| `subscribe(onAction)` | yes | Subscribe to user actions. Returns the unsubscribe function. |
| `close()` | no | Release transport resources. |

### Enrollment (all optional)

A channel that needs one-time onboarding — "scan to bind" — implements these three
additional members. A channel that needs none of it (a fixed webhook URL, say) omits them
all.

| Member | Meaning |
|---|---|
| `enrollmentState()` | The current state: `{ state: 'unbound' \| 'starting' \| 'awaiting' \| 'bound' \| 'failed', stage?, recipient?, verifyUrl?, expiresIn?, message?, appId?, connected?, slow?, persisted?, persistError? }`. **It must not carry any secret** (`appId` is not a secret; it is the app's name). `bound` may only be published **after the transport can actually receive events**, and it must keep reflecting whether the connection is up — the card presents "connected" as a fact, and a vague optimistic state is exactly why a user cannot tell success from failure. While `starting`, `stage: 'creating' \| 'connecting'` says what is being waited on: the QR code (the app is still being created) or the long-connection handshake; `slow` means that wait has run unusually long. The card gives different copy for each — **a click must show "working on it" immediately**, or the user cannot tell "stuck" from "in progress". |
| `beginEnrollment(mode?)` | Start onboarding. Must be **idempotent**: the device-authorization poll outlives the HTTP request that triggered it, so an in-flight run is shared rather than restarted per call. **Publish the waiting state before returning** (the return value may be a Promise): the QR code is one network round trip away, and if publishing waits for `connect`, the click that triggered it answers with *the state it replaced* and the card shows nothing. When a transport is already connected, return the current state instead of opening a second connection. |
| `adoptCredentials({ appId, appSecret })` | Optional: bind directly with **credentials the user already has**. The pair must be checked against the platform *before* connecting — the long-connection handshake **retries** a wrong pair instead of failing, and this one check is what lets the card state the reason. Do not keep a pair the platform rejected; keep one when the platform was unreachable. Credentials belong to the connection opened with them, so switching app means closing the old connection. |
| `clearEnrollment()` | Revoke the binding and the credentials, returning to `unbound`. |
| `resume()` | **Reconnect using stored credentials only**, starting no onboarding. With nothing stored, stay `unbound` and return the current state. The core calls this when the plugin loads, because "click bind again after a restart" is not something a user should have to do. |

The core never starts onboarding by itself, with one exception: when `webServer` is absent
there is no card to ask, so the core calls `beginEnrollment()` directly and prints the link
to the log. **With a UI, the user triggers it from a button in the Settings card.**

The load order is `resume()` → wait for the user's click when there is a UI → `beginEnrollment()`
only when there is no UI and still no connection. So a deployment that has already bound
should, after a restart, **print no link and need no click**; the only log line `resume()` may
emit is a warning when it fails.

## Logging

A channel speaks through the `log` the host hands it (`info` / `warn` / `debug`) and
**must not** let a third-party SDK print to the terminal directly. SDKs usually expose
`logger` and `loggerLevel`: route their output into `log.warn` / `log.debug` so that
**the deployment's own level decides who sees what**, rather than the channel deciding for
every deployment. What the Feishu channel does: the SDK's startup banner, each connection
step, and the event dispatcher's ready line all go to `debug`; errors and warnings go to
`warn` — quiet while it runs, still visible when something is wrong.

## Views (core → channel)

```js
{
  title: string,
  tone: 'warning' | 'info' | 'success' | 'danger' | 'muted',
  body: string[],            // one text block per entry
  buttons: [{ payload, label, tone: 'default' | 'primary' | 'danger' }],
  forms: [{
    payload,                 // echoed back verbatim on submit
    fieldId,                 // the core's name for the submitted value
    options?,                // {label, value}[]; absent renders a free-text input
    customFieldId?,          // the core's name for one extra free-text value
    multiSelect: boolean,
    submitLabel: string,
  }],
}
```

**A view is one message.** One request can carry several questions, and the core sends them
**one per view**, rewriting the same message to the next question as each is answered — the
rhythm the desktop composer already steps through. It never puts two questions' controls in one
view, because a card renders its text blocks first and its controls after them: two questions on
one card would show both questions' text and then both questions' controls, with nothing to say
which button answers which.

## Actions (channel → core)

A channel must echo `payload` back **verbatim**:

```js
onAction({ payload, values, messageId, sender })
```

- `payload` — the `payload` carried by the button the user pressed.
- `values` — form submission, shaped `{ [controlName]: string | string[] }`; `undefined` for a
  non-form button. A form may declare both `fieldId` and `customFieldId`, in which case both
  values arrive in the same submission — that is how a multi-select answer and its "extra note"
  travel together.
- `messageId` — **the message the press came from**, and the core does use it: a press that
  names no live request rewrites that message with its controls removed. Live requests are held
  in memory, so a restart leaves cards on the phone that nothing can answer — without this the
  press produced a toast and the card kept looking answerable. It must identify the message the
  card is in, so that `update` can reach it.
- `sender` — **the acting user's identity on that channel**. The core does not use it for
  authorization, because "who may act" is the channel's own trust model; the Feishu channel
  checks here that it equals the bound recipient.

The return value is `{ toast, accepted }`, which the channel uses for immediate feedback (in
Feishu it maps to a toast popup).

**A channel names its own controls, and says what it called them.** The names in `values` are
the ones the card's elements carry, so a channel that renames them reports the mapping back on
the submit payload, keyed by the `fieldId` / `customFieldId` the view asked for:

```js
// the submit button's payload, for the third form on the card
{ rid, q, submit: true, submits: { value: 'form_2_value', custom: 'form_2_custom' } }
```

The core reads `values` through that map, so it looks up `form_2_value` and not `value`. A
channel that renames without reporting the mapping looks to the core like a submission carrying
no answer at all: the values arrive and are discarded.

Why a channel may have to rename at all: **a card may not hold two elements of the same name.**
The core names a form's controls `value` and `custom` — the same two names on every form, because
a form answers exactly one question — so a channel that builds a card holding more than one form
would repeat them, and the platform refuses the whole card, which reaches the reader as no message
at all. The core does not build such a card: it sends one question per view. The Feishu channel
namespaces each form's controls and reports the map anyway, so that its renderer is correct for any
view it is handed rather than only the ones this core currently builds.

## Security requirements

The core already does its part: `payload.rid` is single-use and random, it dies the moment
the request settles, and an answer must name a label the question actually offered.
**The channel's responsibilities are:**

- Do not interpret or rewrite `payload`, and do not fabricate an `onAction` call without a
  real user interaction.
- **Verify the actor.** A card is a capability: whoever holds the message can press its
  buttons. An answer that comes back from the phone enters the session with human
  attribution (`{ kind: 'user' }`), so "this press really came from the bound recipient"
  must be established by the channel itself — the Feishu channel compares the callback's
  `operator.open_id` against the recipient, and on a mismatch refuses outright without
  calling `onAction`.
- **Do not accept a binding from anyone who can merely reach the bot.** The Feishu channel
  binds only from a direct message to an unbound deployment, never from a group message and
  never over an existing recipient — see
  [ADR 0006](../docs/decisions/0006-binding-is-not-up-for-grabs.md). A channel whose
  transport has a similar "the sender chooses themselves" path owns that same decision.

## Shipping a channel as one file

A channel is one file because that file is the unit this contract is measured in: a
transport that is not Feishu is a new file under `providers/`, not a rewrite of the core.
The reasoning, and what would change it, is recorded in
[ADR 0009](../docs/decisions/0009-a-channel-is-one-file.md).

## Existing channels

| Module | Transport | Onboarding |
|---|---|---|
| `feishu.js` | Feishu long connection (WebSocket); outbound reach is all it needs | **Scan to create an app in one click** (OAuth 2.0 Device Authorization Grant); the credentials and the recipient land in the credential store automatically |

### Candidates for a future channel

| Channel | Outbound only | Can answer | Notes |
|---|---|---|---|
| Telegram Bot | ✅ `getUpdates` long poll | ✅ inline keyboard | `deliver` sends, `subscribe` polls for callbacks |
| ntfy | needs the phone to reach the service | ✅ `X-Actions` buttons | Buttons can call a small HTTP endpoint the host serves itself |
| WeCom / DingTalk | ✅ long connection | ✅ interactive cards | Structurally identical to Feishu; adapt `feishu.js` directly |
| Bark / ServerChan | ✅ | ❌ push only | `supportsForms: false`, notification only |
