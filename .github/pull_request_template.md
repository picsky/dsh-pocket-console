<!--
One topic per pull request. If this changes more than one thing, say below why
they cannot land separately — a PR is squashed into one commit on `main`, so the
description is what the history records.

An unticked box is allowed; an unexplained one is not. Delete a line this change
genuinely does not touch, and say why in the notes.
-->

## What this changes

<!-- What was wrong or missing, and what the change does about it. Two sentences is plenty. -->

Closes #

## Checklist

- [ ] `npm test` is green, and new behaviour has a case in `tests/` that fails without it
- [ ] A user-visible change moves `CHANGELOG.md`, under **Unreleased**
- [ ] A new or changed setting agrees in all six places (`npm run check:parity`)
- [ ] `README.md` and `README.zh-CN.md` are updated together, or only one changed for a reason below
- [ ] A non-obvious choice is recorded in `docs/decisions/`, or an existing record is cited
- [ ] A change to `files`, `exports`, or `bundleDependencies` leaves the tarball installable (`npm run e2e`)
- [ ] A security property that moved is a line in `SECURITY.md` and a case in `tests/`
- [ ] No secret, `open_id`, tenant identifier, or real card content appears in this diff, the logs, or a screenshot

## Notes for the reviewer

<!--
What the diff cannot say: what you tried and rejected, what is deliberately out
of scope, and what still needs a real Feishu tenant (or a phone) to confirm.
-->
