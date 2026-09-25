# 0029 — The card degrades visibly, and asks for platform UI by capability

**Status:** accepted.

## Context

0.1.7 renamed the shell's whole icon family — a size suffix became a weight one —
and left no alias behind: `IconChevronDownOutline14` became
`IconChevronDownOutlineRegular`. This bundle destructured the old name at load, so
on 0.1.7 it was `undefined`, and `h(undefined, {})` is not a missing decoration:
React throws *"Element type is invalid"* on the first render.

What the platform does with a throwing entry is the part worth writing down. The
slot renderer wraps each entry in an error boundary and **retires it** — the card
disappears from the page *and* from the summary line beside the plugin's name, on
every later render, while the page around it stays perfectly healthy and the plugin
itself keeps working. The same trailing silence came from the card's own guard: an
unavailable settings form returned `null`, so "the Host serves no form" and "the
card crashed" looked identical from the outside — like a page that simply has no
settings.

Both costumes are the same failure: something in the platform moved, and the card
answered by not being there.

## Decision

Two rules, both about answering rather than disappearing.

**Platform UI is asked for by capability.** The chevron is taken from whichever
name the Host seeds — the weight-suffixed one first, the size-suffixed one as the
fallback — and when a Host seeds neither the card is drawn with no chevron. A name
that moved costs a decoration, never the card.

**Every state the card can be in is rendered.** A settings form that is still
`loading` says so; one the Host does not serve says that; a card handed no form
hook (the renderer binds `usePocketConsole` from the injected hooks compartment)
explains itself instead of throwing. `PocketConsoleCard` never returns `null`.

## Consequences

- The 0.1.7 blank page is a sentence now, whichever way it happens again: the card
  renders what it knows, and the one thing it cannot render is nothing.
- `tests/client.test.mjs` pins all three icon surfaces — the 0.1.7 name alone, the
  ≤ 0.1.6 name alone, and neither — plus both non-ready statuses and the missing
  hook. The 0.1.7-name case fails against the size-suffixed lookup alone, which is
  what makes it a regression test rather than a description.
- The rule is not free: the card carries the failure as copy, in both languages,
  because a reader who sees it is the one who has to decide whether to upgrade
  something.
