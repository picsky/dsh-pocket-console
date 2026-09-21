# 0010 — The channel names its own controls, and says what it called them

**Status:** accepted.

## Context

A card is a document with a rule the core cannot see: **it may not hold two elements of the
same name.** The core's view names every question's controls `value` and `custom` — the same
two names on every form, because a form answers exactly one question and the decoder reads it
one question at a time. That is correct in isolation and wrong in aggregate: one request can
carry several questions, so a card answering three of them held three elements called `value`.
Feishu refused the whole card, and the failure reached the reader as **no message at all**,
with the only trace a delivery warning in the deployment log.

The naming rule belongs to the platform, not to this plugin, and a channel is the only side
that knows it. `supportsForms: false` channels render buttons and have no names at all; another
platform may allow duplicates, or require a prefix, or forbid a digit. The core renders a
channel-neutral view, and "what an element is called" is not channel-neutral.

## Decision

**The core asks for values by name; the channel decides what its card calls them, and reports
the mapping back on the submit.**

- The view keeps naming what it wants — `fieldId`, `customFieldId` — and those names are what a
  form's answer is *requested* under.
- The channel names its own controls to suit the card it is building. Where a card would repeat
  a name, it namespaces.
- The submit payload carries `submits`, keyed by the names the view asked for:

  ```js
  { rid, q, submit: true, submits: { value: 'form_2_value', custom: 'form_2_custom' } }
  ```

- Every decoder reads `values` through that map, with the view's own name as the fallback for a
  payload that reports nothing.

The core does not declare `submits` in the view. It already declares `fieldId` and
`customFieldId`; a second field saying "the names I just gave you" would be a restatement, and
two places to keep in step.

The fallback is not decoration. A card that is already in someone's chat was rendered by the
version that shipped before this report existed, and its submit carries no map. Reading it under
the core's names is what keeps those cards answerable — which is what makes this change
non-breaking rather than a silent break for every message already sent.

## Consequences

- A channel that renames without reporting looks to the core like a submission carrying no
  answer: the values arrive and are discarded. `providers/README.md` states this where a channel
  author reads it, because it is the one way to get this wrong now.
- Both decoders — the escalation and the result notice — read through the map, so a control's
  name can change with the card without changing either decoder. The notice path reads the map
  too, because the notice path's card now carries **two** forms (the reply box and the next-task box,
  see [0019](0019-the-next-task-rides-the-result-card.md)), and the map is the only thing keeping
  their names apart.
- `tests/notices.test.mjs` and `tests/questions.test.mjs` read control names off the card instead
  of hard-coding them. The harness can only pass a form value under a key the caller chose, so a
  test that hard-codes `value` asserts nothing about the card: it passed while every real reply
  was being dropped. Binding to the rendered name is what makes these claims about the wire.
- Two controls must share a name for the platform to refuse the card, so the regression is only
  visible with two or more forms in one card. The test that covers it asks four questions, three
  of which need a form, and asserts no name repeats.

## Alternatives

**Namespace in the core, once per question.** Rejected: the core would be encoding one platform's
element-naming rule, and it still could not know whether a channel renders forms at all, or what
its card looks like.

**Namespace in the channel and keep the decoder guessing.** Rejected: the channel's control name
would become an unwritten part of the wire contract, discoverable only by reading the renderer.

**Keep one form per card**, splitting several questions across several messages. Rejected: the
point of the escalation is that the reader answers once, from the phone; a chat full of cards for
one decision would be worse than the bug.
