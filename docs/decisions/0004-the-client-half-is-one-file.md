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
  copy is still Chinese-only, which a `messages.js` dictionary on the Host side
  would fix.
