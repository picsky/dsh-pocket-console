<!--
One topic per pull request. If this changes more than one thing, say below why
they cannot land separately — a PR is squashed into one commit on `main`, and that
commit keeps the branch's own commit messages, so write those as if they were the
record. They are.

An unticked box is allowed; an unexplained one is not. Delete a line this change
genuinely does not touch, and say why in the notes.
-->

## What this changes

<!-- What was wrong or missing, and what the change does about it. Two sentences is plenty. -->

Closes #

## If this is a release PR

<!-- Delete this block for anything that is not a release. The full process is docs/releasing.md. -->

- [ ] the version bump, the changelog section and `RELEASE-NOTES.zh.md` agree
- [ ] both halves of the release body name the DSH versions verified (`npm run check:dsh-version`)
- [ ] the support window in `docs/releasing.md` and `README.md` matches `ci.yml`'s `real composition` matrix
- [ ] the version is a **batch** — everything merged since the last release, not one fix
- [ ] a plain version is meant for `latest`; a candidate is `-rc.N` and publishes to `next`
- [ ] **after** the tag publishes a candidate: installed it into a real profile and used it — the
      card is visible, the settings load and save, binding still works — with the evidence
      (console line, screenshot, or `/__pocket/state`) linked here, and only then promoted with
      `npm dist-tag add dsh-pocket-console@<version> latest`

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
