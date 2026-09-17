# 0004 — The client half stays one file

**Status:** accepted.

## Context

The browser half is materialized as a single module-table row. The loader hands its
factory a `require` that resolves **bare specifiers only** — the modules the shell
seeds — and nothing else, so `client.js` has no relative imports to split along.

## Decision

`client.js` stays one file, organised by sections in reading order: copy, the
settings form, the card, the mirror, and `apply`. Splitting it is not a refactor;
it is a build step, which [0001](0001-no-build-step.md) rules out.

## Consequences

- The whole browser half is read top to bottom; sections and their JSDoc carry the
  structure a module boundary would otherwise carry.
- Two halves of one feature can live in different files only when they are on
  different sides of the wire (the Host's `escalation.js` and `mirror.js` have no
  browser counterpart in the bundle).
- The card's copy is bilingual through a dictionary in this file; the phone card's
  copy comes from the Host's `messages.js`. The browser half reports the interface
  language with its state reports, and the deployment's `locale` only covers a page
  that never opens.
- The card's state store is fifteen hand-written lines rather than
  `createSnapshotStore` from the shell-seeded `@deepseek-ai/dsh-client-store`. The
  shell does seed that module, but the export surface of the *installed* release
  cannot be checked from this repository, and the browser half has no test that
  would catch a wrong name — so the swap waits until the GUI itself is exercised,
  rather than trading fifteen lines for an unverifiable regression.
