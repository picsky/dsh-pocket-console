# 0014 — The process binds every change, and the release keeps one documented shortcut

**Status:** accepted.

## Context

The repository became public with **no rules on `main` at all**: no protection, no ruleset,
no required check, all three merge methods allowed, and `delete_branch_on_merge` off. Four
checks already ran on every pull request and every push, and not one of them could stop
anything. The release workflow was reachable by pushing a `v*` tag — by any account holding
write access.

That is survivable while there is exactly one contributor, and it stops being survivable at
the first outside pull request, which is also the moment it becomes expensive: a contributor
cannot see a process that exists only in the maintainer's habits, and a reviewer cannot ask
for a rule that was never written down. Nothing had gone wrong. Nothing had been tested
either.

Two facts decided the shape of the fix:

- **A tag is a publish.** `release.yml` exchanges the run's GitHub OIDC identity for a
  short-lived npm credential, so the permission to create a `v*` tag is the permission to
  publish this package to every deployment. It was the one powerful action in the repository
  that no rule guarded, and it was not an accident of configuration — the workflow is
  tag-driven on purpose, so that the artifact and the commit that produced it are the same
  thing (the drift 0.8.1 existed to remove).
- **A required check can lock a repository.** If a change breaks CI itself, every pull
  request is red, and the fix for CI is a pull request that cannot merge. A ruleset with no
  exempt actor is a rule that can only be broken by disabling it.

## Decision

**Every change to `main` arrives as a pull request, the four existing checks are required
without exception, history stays linear, and the maintainer keeps one documented shortcut
that cannot publish anything CI has not verified.**

- **`main` requires a pull request** — required approving reviews: **0**. Not a lapse: a
  review requirement is satisfied by somebody other than the author, and with one maintainer
  a non-zero count makes every pull request unmergeable, including the maintainer's own. The
  pull request is required for what it produces (a description, a diff, a check run, a
  record), and the count is raised to 1 the day a second maintainer exists.
- **All four checks are required, on every diff**: `verify (node 22)`, `verify (node 24)`,
  `real composition`, and `publish payload`. No `paths` filter, ever, including for a
  docs-only change: a required check that a diff skips reports *pending* forever, so the
  pull request can never satisfy the ruleset. Four minutes of runner time is the cheaper
  failure.
- **Squash merges, linear history, no force-push, no branch deletion.** One pull request is
  one commit on `main`, and the configuration keeps the branch's **commit messages** rather
  than the pull request's description (`squash_merge_commit_message: COMMIT_MESSAGES`), so
  what is written on the branch is what the history keeps and the merge box is the last place
  it can be corrected. This is why the process asks for one topic per pull request: the
  intermediate commits are collapsed, and what survives has to read as one change.
- **The repository administrator is a bypass actor on the branch ruleset, and that is the
  whole shortcut.** It exists for the two cases where the rules are the obstacle rather than
  the safeguard: repairing CI when CI is what is broken, and landing a fix during an
  incident. It is not a faster route for ordinary work, and GitHub records every use as a
  bypass on the ruleset's insights, so "documented" is checkable rather than a promise.
- **`v*` tags may be created only by the maintainer, and nobody else may update or delete
  one.** The ruleset's bypass actor is again the administrator, because the maintainer is who
  publishes; everyone else is refused, which is the actual change — before it, write access
  and publish access were the same thing. The bypass covers deletion as well, deliberately: a
  tag pushed by mistake has to be recoverable, and a tag that names nothing publishable is
  harmless once it is gone. The tag ruleset is the only place this is written down for anyone
  who is not the maintainer, since the workflow itself cannot refuse a tag that it never gets
  to see.
- **The release workflow re-checks what the ruleset assumes**: the tagged commit must be an
  ancestor of `origin/main`, and its four checks must have concluded `success`. A tag is not
  a claim about a commit; it is a commit, and the shortcut exists to let a human act quickly,
  never to let an unverified commit reach the registry. Where the ruleset can be bypassed,
  the job cannot.

The written form of all this — what a contributor does, in order, and what a pull request
must carry — is `CONTRIBUTING.md` and the pull request template. This record is the argument
behind it.

## Consequences

- A documentation-only pull request now costs a full `real composition` run. That is the
  price of "no skipped required checks", and it is paid in minutes of a runner, not in
  anyone's attention.
- Releasing is two steps instead of one: merge the version bump and the changelog behind a
  pull request, then tag the merge commit once `main` is green. `npm version minor` followed
  by `git push --follow-tags` no longer describes the flow, and `docs/releasing.md` was
  rewritten with it.
- A tag pushed before `main`'s checks finish is refused by the workflow, and the recovery
  depends on which assertion refused it. The check runs are read live, so if CI was still
  running the job passes on a re-run once `main` is green — that guard was asking about *now*.
  The ancestry guard is asking about the commit, and no re-run changes that answer; the tag has
  to be deleted through the bypass and pushed again against a commit `main` holds.
- The bypass is a real hole, and it is bounded rather than eliminated: it can put an
  unverified commit on `main`, and it can therefore make the ancestry check pass for a
  commit CI never judged. That is the reason this record exists instead of a comment in the
  ruleset UI — a shortcut nobody can name is a rule nobody follows — and the reason the
  release workflow still asserts the checks even though the branch ruleset already required
  them on the way in.
- A contributor's first pull request has checks that stay *pending* until a maintainer
  approves the workflow run. `CONTRIBUTING.md` says so, because from the outside it is
  indistinguishable from a broken build.
- One more thing is now inside the repository rather than in the maintainer's head:
  `internal/maintaining.md` holds the triage rules, the review order, the merge steps, and
  the repository settings verbatim, so a settings change is reviewable in the history rather
  than only in the GitHub UI.

## Alternatives

**Leave `main` unprotected and write the process down.** Rejected: prose cannot refuse a
push, and the promise being made is about what happens to a stranger's pull request. A
written rule with no gate behind it is the state the repository was already in, with more
words.

**Apply the same rules with no bypass at all.** Rejected above, and it is the alternative
worth arguing with, because it is the purer one: it makes the ruleset absolute and removes
the one hole. It also makes a broken workflow unfixable through the front door, which turns
"CI is red for everyone" into "ask the administrator to disable the ruleset", which is the
same bypass with extra steps and no record.

**Require one approving review.** Rejected: with a single maintainer it is a lockout rather
than a safeguard, and GitHub does not let an author approve their own pull request. The
correct moment for it is the arrival of a second maintainer, and it is a one-field change
then.

**Skip the expensive checks for documentation.** Rejected: a required check that is skipped
by a `paths` filter never reports at all, so the pull request waits on a status that will
never arrive. The alternative — making `real composition` non-required and running it on
demand — was rejected too: it is the only check that proves the plugin *activates*, which is
the failure this repository has already shipped once.

**Protect the release with an environment that requires a manual approval.** Rejected for
now, not forever: it adds a second human step to every release of a one-person project, when
the tag ruleset already restricts who may start one and the workflow already verifies the
commit it is publishing. It becomes the right answer when a maintainer other than the
publisher holds the credentials.

**Publish from a dedicated `release` branch.** Rejected: the tag would then name a commit
that is not what `main` holds, which is precisely the drift that 0.8.1 was released to
remove — the registry's artifact, the tag, and the repository's `main` are meant to be one
commit.
