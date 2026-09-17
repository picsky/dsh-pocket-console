# 0003 — A phone instruction is human input

**Status:** accepted.

## Context

The harness assigns `{ kind: 'user' }` to messages that come from a human surface
and reserves it against producers that merely act on a human's behalf
(`packages/goal/tool-goal/README.md`: plugins, schedulers, and other non-human
producers must pass their own source). The harness's own remote client — the ACP
bridge, where a person types into an editor — mints `{ kind: 'user' }` for that
prompt (`packages/acp/acp/src/session.ts`), because the surface a person is speaking
through is what attributes the message.

A result notice carries a text box. What the reader types there is the same person
speaking through a different surface.

## Decision

The instruction enters the session as `{ kind: 'user' }`, attributed by the surface
the reader is using.

## Consequences

- It renders as the reader's own message in the Web flow. Anything else is
  classified as injected context and folded into the turn's process, which is what
  made the instruction invisible before.
- It carries human authority: features that require human input accept it, and the
  session log does not distinguish it from a message typed at the desk.
- Because a decision from the phone can become human-attributed input, the channel
  must prove the press came from the bound recipient (`providers/feishu.js`). The
  two decisions hold together: neither is safe alone.

## Alternatives

A plugin-sourced message: honest about the producer, but it renders as folded
injected context and is refused by human-authority features.
