# 0002 — The desktop mirror runs in the browser

**Status:** accepted, with a known upstream gap.

## Context

`approval/request` and `user-questions/request` are forwarded to the browser, and
the forwarding layer finishes a request only when a browser answers it
(`gateway.receiveRemoteEventResult` → `finishRemoteEvent`). This plugin answers the
waterfall ahead of that forwarder, so a request the phone answered settles for the
model while the forwarded copy stays pending for ever: the GUI's composer keeps
waiting for a decision that already happened.

The Host cannot withdraw it — `settleRemoteEvent` and `cancelRemoteEvent` are
private to the Gateway, and the event's lifetime signals belong to the forwarder —
so no plugin-side Host code can end it.

## Decision

The Host records the decision it accepted (session, question ids, answer) for a
bounded window on the state route it already serves. The browser half reads it and
applies it through the pending interaction the Session UI publishes — that is,
through the same `pending.answer()` call the desktop's own **Submit** button makes
(`QuestionComposer`). The request then settles from the browser, the Gateway
finishes it and pushes its cancel frame, and the composer closes.

## Consequences

- The desktop follows a phone answer within about a second, including approvals,
  whose client decision type is the value the Host settles with.
- It needs an open page. With none, there is nothing to mirror, and a page opened
  later never replays an expired decision (`mirrorTtlSeconds`).
- The browser half reads another plugin's published snapshot rather than a
  documented extension point. The shape is guarded and fails soft, and the proper
  fix is upstream: a cancellation path in `forwardWaterfall`, or a documented
  remote-answer relay. Until then this record is the honest statement of the gap.

## Alternatives

Driving the composer's DOM (fragile, invisible to the reader); leaving it as it
was (the reported bug: an answer that reaches the model while the panel stays).
