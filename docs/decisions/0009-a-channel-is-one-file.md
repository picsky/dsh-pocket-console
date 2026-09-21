# 0009 — A channel is one file

**Status:** accepted.

## Context

`providers/feishu.js` is one of the largest files in the repository, at just over a
thousand lines. It carries five things that a reviewer would normally expect to see
separated:

- the credential check against the platform, and the error classification that turns a
  refusal into a sentence;
- the SDK's logging routed into this deployment's log;
- card rendering, which turns a channel-neutral view into Feishu's schema 2.0 JSON;
- the enrollment lifecycle — one-click app creation, adopting a pair, resume, unbind,
  and the generation counter that keeps a cancelled run from writing over its
  replacement;
- the transport itself: the long connection, the two event handlers, `deliver`,
  `update`, and the recipient binding.

By the usual rule — one file per concern — this should be five files.
[0004](0004-the-client-half-is-one-file.md) argues the browser half cannot be split,
but its reason is mechanical: the loader's `require` takes bare specifiers only, so a
relative import does not resolve there. That reason does not apply here. `feishu.js` is
ordinary Node ESM and could import a sibling without complaint.

## Decision

**A channel is one file, and the file is the unit the contract is measured in.**

[`providers/README.md`](../../providers/README.md) states the contract, and
`CONTRIBUTING.md` turns it into a rule for contributors: a channel that is not Feishu is
*one file under `providers/`* implementing that contract. The plugin's `channel` setting
points at a single module and calls its single `create()`. Adding Telegram, WeCom, or
ntfy is a new file at the same path depth, and nothing in the core changes — that is the
property the whole split exists to protect.

Splitting `feishu.js` internally would not break that property today, and that is
exactly the risk: it would make "a channel is a directory" the shape a *second*
contributor copies, and the contract would then be spread across a directory
convention that `providers/README.md` would have to describe. The five concerns above
are also not independent — the enrollment lifecycle exists to produce the credentials
the transport uses, and the card renderer exists to be called by exactly two methods.
The boundaries are real but thin, and a module boundary per concern would buy
navigability at the cost of the one thing this plugin is selling.

The file is organised by commented sections in reading order instead, the same way
`client.js` is.

## Consequences

- The channel contract has one implementation to read and one to copy. A contributor
  adding a transport reads a single file end to end, which is what makes the "new file,
  not a rewrite" claim true rather than aspirational.
- `feishu.js` is long. A reviewer who wants only the enrollment state machine must
  scroll; the section comments and the module JSDoc are what stand in for a file
  listing, and they are load-bearing rather than decorative.
- If a second channel ever ships, this record is what should be revisited first: two
  single-file channels sharing duplicated helpers — the deadline race, the byte-aware
  card rendering — would be the evidence that a shared `providers/` support module has
  earned its place. One channel does not justify one.

## Alternatives

**Split by concern, with `feishu.js` as a thin composition root** importing
`feishu-enrollment.js`, `feishu-cards.js`, and the rest. Defensible on length alone, and
rejected because it changes the shape a second channel is expected to take while the
contract still describes a single file.

**Leave it and record nothing**, on the grounds that length is not a decision. Rejected
because the length is the thing a reader notices first, and the honest answer —
"deliberate, and here is what would change it" — is worth more than a silence that
reads as an oversight.
