# 0030 — A release is a batch a person has run, not a fix a machine has accepted

**Status:** accepted.

## Context

On one afternoon this repository published **three stable versions in 103 minutes**, all of
them for the same problem: 0.9.3 fixed a boot failure on DSH 0.1.7 and registered no settings
card, 0.9.4 mounted the card and the card threw, 0.9.5 was the first one that worked. Every
one of those releases had four green checks, 276 green tests, a provenance attestation and a
verified registry read-back, and every one went straight to `latest`, which is what every
deployment installs. The two broken ones were found by a person opening the page and taking a
screenshot.

That is a process failure with two distinct halves, and they need two different fixes.

**The version line lost its meaning.** A version number is a claim about a batch: that these
changes were verified together, by the same gates, at the same moment. Publishing per fix
turns the number into a sequence counter, and makes every user an unplanned participant in the
next attempt. Nobody could tell from `0.9.4` that it superseded `0.9.3` in under an hour.

**Nothing had run what a user runs.** The gates verified the *tree* — unit tests against a
hand-built context, a real composition on one pinned harness, a registry read-back — and the
failures lived one layer out: a Cordis entry left pending because a browser service was
renamed, and a React render that threw because an icon name changed, which the slot renderer
answers by retiring the entry. A machine gate cannot see a page; the closest it can come is to
boot the real application on the real harness with the real tarball and read what the browser
would read.

## Decision

**A version is a batch.** Everything merged since the last release goes out together, and a
follow-up fix to something already merged amends the unreleased section rather than opening a
version of its own. Three versions in one afternoon is the failure this rule names.

**`latest` only ever points at a version a person has run.** A version with a prerelease
suffix publishes to the `next` channel; promotion is `npm dist-tag add … latest`, a separate
recorded act, taken only after the release checklist's one human line is ticked: the candidate
was installed into a real profile, the plugin page showed the card, and the settings loaded and
saved. A candidate that fails is re-cut as the next `rc`, and `latest` does not move.

**The artifact is verified before it is published, on every harness in the support window.**
`npm run verify:artifact -- <tarball>` installs the file the release is about to upload into a
throwaway profile, boots the real application on a named DSH version, reads the plugin's
routes, checks the boot manifest carries the entry, and compares the client bundle the shell
would serve with the one the tarball installed. `ci.yml` runs the same check on every pull
request, once per harness leg, so the path a release takes is the path every change takes.

**The support window is two harnesses, named, and stated in the release.** Both legs run in CI
and again on the tarball before publishing; the release notes say which ones were verified. A
harness outside the window may work — nothing claims it does.

**A wrong release is deprecated, not withdrawn.** `npm deprecate` with the symptom and the
fixing version, `latest` moved back if it was promoted, and the fix carried forward in the next
version's notes.

**A person approves the publish.** The job names a `npm-publish` environment, so a repository
that adds required reviewers gets a human gate on the one action that reaches every
deployment; with no reviewers configured it is inert, which keeps a clone able to run the
workflow unchanged. It is deliberately a coarse gate: machine gates run after approval, never
before it, so an approval cannot publish something unverified.

**Not adopted: generated versioning.** `changesets` and `release-please` solve version
bookkeeping across many packages; this repository has one package, a hand-written bilingual
release body whose two halves are asserted against each other by `check:dsh-version`, and a
changelog whose voice is part of the product. A generator would take the version arithmetic
away and the accountability with it, and the arithmetic was never the problem here.

## Consequences

- The failure that started this — a version that could not boot on the harness everyone was
  about to install — becomes a candidate that fails its checklist, or a red artifact check,
  rather than a `latest` release someone discovers on their own machine.
- A release now costs more: one artifact verification per harness leg before publishing, and
  one human run of the candidate afterwards. That is the price of `latest` meaning something.
- The rules that keep a card visible at all (0028, 0029) are what the artifact check and the
  checklist exist to enforce; this record is about where they are enforced.
