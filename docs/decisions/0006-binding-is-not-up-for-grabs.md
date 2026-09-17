# 0006 — A direct message binds, but never re-binds

**Status:** accepted.

## Context

The recipient is the whole trust anchor of this plugin. It decides where approval
cards are delivered, and the channel honours a press only when the operator's
`open_id` equals it (`providers/feishu.js`). A press then becomes human-attributed
input in the session (record [0003](0003-a-phone-instruction-is-human-input.md)),
so the recipient is ultimately who may grant a tool call.

The recipient has to come from somewhere without the user pasting an id into
configuration, so a message to the bot was taken as the user identifying
themselves — "a direct message is the user asking to be reachable here". The
handler read `sender.sender_id.open_id` and wrote it, unconditionally, with no
check on the message itself and no allowance for the deployment already being
bound.

That is a takeover path, not an onboarding convenience. The bot's own address is
discoverable inside a tenant, the requested scope is read-only *messages*, and an
app adopted with its own credentials can carry any scopes its console has — so a
group message can reach the same handler. Anyone who could reach the bot could
therefore become the recipient: every later approval card (tool name, reason, and
an "allow once" button) would be delivered to them, and their presses would pass
the operator check. The check itself was never the weak part; the value it
compares against was.

## Decision

**A direct message binds an unbound deployment and nothing else.**

- `chat_type` must be `p2p`. A group message is refused however the app is scoped,
  because speaking in a group is not claiming this deployment's operator role.
- A deployment that already holds a recipient refuses the message and logs it.
  Changing the recipient stays a deliberate act in the Settings card — **Use
  another app**, or **Unbind** followed by a new direct message — where the person
  is looking at the state they are changing.

## Consequences

- The zero-configuration path still works: install, restart, send the bot a
  message, and it is bound. Nothing about the first run becomes harder.
- Recovering from a *moved* recipient (a replaced phone, a reinstalled app) now
  costs one explicit step instead of happening by itself. That is the trade: the
  conveniences are not symmetric, because binding is an authorization and
  re-binding silently invalidates the previous owner's authority.
- An adopted app no longer keeps a recipient learned from a different app. Feishu
  scopes an `open_id` to the app that resolved it, so the old id addressed nobody
  under the new app: the card now shows the "not bound yet" hint instead of a
  recipient that could never receive anything.

## Alternatives

**A confirmation token** — the card shows a code, the direct message must contain
it. Stronger, and it also covers the moved-recipient case; rejected as the first
step because it makes the *first* run (a person holding a phone, looking at a QR
code) require copying a code out of a card they have not yet proven they can
receive.

**Any direct message re-binds, with a warning to the previous recipient.**
Rejected: the previous recipient is exactly who may no longer be trusted, so
telling them is not a control. It also leaves a race — the window between the
takeover and the notice is enough to approve a call.
