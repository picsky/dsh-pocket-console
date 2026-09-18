# Maintaining

The maintainer's side of the process: triage, review, merging, releasing, and the
repository settings that enforce all of it. Internal — deliberately **not** in
`package.json`'s `files`, so no installer carries it. The contributor's side is
`CONTRIBUTING.md`; the argument for the rules themselves is
[ADR 0014](../docs/decisions/0014-the-process-binds-every-change.md).

Nothing here is a secret, and nothing here is a second copy of a contributor-facing rule.
If a line in this file changes what a contributor must do, that line belongs in
`CONTRIBUTING.md` instead.

## 1. Triage

Look at the tracker when there is something in it. There is no SLA, and inventing one for a
side project is how a promise becomes a failure; what the repository does promise is in
`CONTRIBUTING.md` — a report gets read, and a pull request gets an answer in days.

**Labels.** The GitHub defaults plus two of this project's own:

| Label | Means |
|---|---|
| `bug` | The behaviour disagrees with a document or a decision record |
| `enhancement` | A change request; what the feature-request form files |
| `documentation` | A document is wrong, missing, or links somewhere that is not there |
| `good first issue` | Small, self-contained, and the surrounding contract is written down |
| `help wanted` | Wanted, and not something the maintainer is going to get to soon |
| `question` | Answered, then closed — Discussions is the better room for the next one |
| `breaking` | A change a deployment must read the changelog for before upgrading |
| `channel` | A transport contribution: a new file under `providers/` |

There is deliberately **no `security` label**: a public label on a private report is a
contradiction. Security reports arrive through `SECURITY.md`'s private channel and never as
an issue.

**Closing.** Say why, in the thread, and prefer closing to leaving something open that
nobody will do. The three honest reasons are in `CONTRIBUTING.md`; the one to add here is
*cannot reproduce* — ask for the `pocket-console:` log lines and the `dsh --version`
before assuming the report is wrong.

## 2. Reviewing a pull request

Review in this order, because the later questions are wasted work if an earlier one fails:

1. **Does it belong in the plugin?** The position is in `README.md`, and the refusals after
   it are load-bearing. A change that contradicts a decision record needs a new record, not
   a quiet edit.
2. **Does it arrive with the case that pins it?** `npm test` must fail without the change.
   A behaviour change with no new case is a claim nobody can check.
3. **Is a non-obvious choice recorded?** If the reasoning is not readable from the file that
   implements it, it is an ADR.
4. **Can the diff be smaller?** Ask once, plainly. Most first contributions are right in
   substance and too large in surface.

For a first-time contributor, GitHub holds the workflow run until it is approved — *Actions*
tab → the run → **Approve and run**. That is why their checks sit at *pending* with nothing
behind them, and it is the one step a contributor cannot do for themselves.

**Merging.** Squash only. The pull request's description becomes the commit message on
`main`, so edit it if the author left it thin: the history is the only place the reasoning
survives a squash. Then confirm `main` is green before moving on — the push to `main` gets
its own CI run, and it is the run that says the merge is real.

```sh
gh pr view <n> --json files,title -q '.title'
gh pr merge <n> --squash --delete-branch
gh run list --branch main --limit 3
```

## 3. Releasing

The tag is the release, and the tag ruleset allows only the maintainer to create a `v*` tag.
The flow is two steps now, and both are enforced:

1. **Bump and describe, in a pull request.** `package.json`'s version and the changelog
   entry, moved out of **Unreleased** into the new section. `npm version minor
   --no-git-tag-version` writes the version without committing or tagging, which is what
   this flow wants. Title the pull request `Release x.y.z` so the squash commit on `main`
   says what it was.
2. **Tag the merge commit, once `main` is green.** Not the branch's head commit, and not a
   local commit that was never pushed — the release workflow refuses both (see below).

```sh
git fetch origin
git switch main && git pull --ff-only
git log --oneline -1                     # the squash commit, and it must be on main
git tag -a v0.9.0 -m "Release 0.9.0" <sha>
git push origin v0.9.0
gh run watch                             # Release → publish to npm
```

Then verify it went out, from the registry rather than from the run's summary:

```sh
pnpm view dsh-pocket-console versions
```

**What the workflow refuses, and why that is the point.** Before it installs anything, it
asserts that the tag names `package.json`'s version, that the tagged commit is an ancestor
of `origin/main`, and that all four CI checks on that commit concluded `success`. The
administrator's ruleset bypass exists so a human can act quickly; it must not become a way
for a commit CI never judged to reach the registry, so the job re-checks what the ruleset
would have required. A tag that fails the ancestry or check assertion gets **no** publish,
and the recovery is to wait for `main` to be green and tag again — never to re-run the job,
because the guard is asking about the commit.

`docs/releasing.md` is the published account of the same path, including the trusted
publisher setup, the hand-publish fallback, and what to do when npm itself falls over.

## 4. The rules, verbatim

Two repository rulesets, plus repository settings. They are written out here so a change to
them is reviewable in the history rather than only in the GitHub UI, and so they can be
re-applied if the repository is ever rebuilt.

**`main`** — a branch ruleset, active, with the administrator as its one bypass actor:

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
    } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "verify (node 22)" },
          { "context": "verify (node 24)" },
          { "context": "real composition" },
          { "context": "publish payload" }
        ]
    } }
  ]
}
```

`strict_required_status_checks_policy: false` on purpose: requiring a branch to be *up to
date* before merging re-runs every check after every merge, and the merge is already gated
on the checks that ran against the diff being merged.

**`release tags`** — a tag ruleset, active, administrator as its bypass actor:

```json
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
```

`actor_id: 5` is the repository-admin role, and it is not a number to guess: the API returns
the id and not the role's name, so it is confirmed by pushing with and without it (see §5).
Deleting a tag is allowed for the maintainer, because the bypass covers the whole ruleset —
that is what makes a mistaken tag recoverable, and it is why the release workflow's own
assertions carry the weight they do.

**Repository settings** that are not rulesets:

| Setting | Value | Why |
|---|---|---|
| Merge methods | squash only | One pull request is one commit; linear history is what the tag then points at |
| `delete_branch_on_merge` | on | The branch is the pull request; a deleted one is not clutter to triage |
| Auto-merge | on | A contributor may enable it; it waits for the four checks |
| Dependabot security updates | on | Off until ADR 0014; it is a free alarm for a bundled transport |
| Wiki, Projects | off | Unused surfaces that rank in search and go stale |

Read any of it back rather than trusting the UI:

```sh
gh api repos/picsky/dsh-pocket-console/rulesets --jq '.[] | "\(.id)  \(.name)  \(.target)"'
gh api repos/picsky/dsh-pocket-console/rulesets/<id> --jq '.rules[].type'
gh api repos/picsky/dsh-pocket-console --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge, allow_auto_merge}'
gh api repos/picsky/dsh-pocket-console --jq '.security_and_analysis'
```

## 5. Changing the rules safely

The rules can lock the repository, so a change to them is rehearsed rather than hoped for.
Three checks, in this order, and none of them leaves anything behind on `main`:

1. **The required check names are the ones CI actually reports.** Read them off a real pull
   request's head: `gh api repos/picsky/dsh-pocket-console/commits/<sha>/check-runs --jq
   '.check_runs[].name'`. A context that no check ever reports leaves every pull request
   pending forever, which is a lockout with a green-looking UI.
2. **A refused push costs nothing, so test the refusal first.** With the bypass actor
   temporarily removed, an empty commit pushed to `main` and an unused `v*` tag must both be
   refused. Nothing is written to the repository and no workflow starts, so this is the
   cheapest possible proof that the rule bites — and GitHub's `remote: error: GH013 …` block
   is the evidence to keep.
3. **Then add the bypass back and confirm it is the actor it claims to be**, by pushing the
   same unused tag: it should be accepted, the Release run should refuse it at the version
   assertion, and the tag should then be deleted. A tag that names no version is inert; it
   never reaches the registry. The acceptance prints `remote: Bypassed rule violations for
   refs/tags/…`, which is what says the bypass belongs to the administrator rather than being
   a hole nobody owns.

```sh
# 2 — with bypass_actors: []
git commit --allow-empty -m "probe: the ruleset must refuse this"
git push origin main                  # GH013: "Changes must be made through a pull request"
git tag v0.0.0-not-a-release
git push origin v0.0.0-not-a-release  # GH013: "Cannot create ref due to creations being restricted"
git reset --hard HEAD~1
git tag -d v0.0.0-not-a-release

# 3 — with the bypass actor restored
git tag v0.0.0-not-a-release
git push origin v0.0.0-not-a-release  # accepted, and printed as "Bypassed rule violations"
# the Release run now fails at "The run must be the tag it publishes"; nothing is published
git push --delete origin v0.0.0-not-a-release
git tag -d v0.0.0-not-a-release
```

GitHub records every bypass on the ruleset's insights, so the shortcut taken in an emergency
is visible afterwards without anyone having to remember it.

**Do not** temporarily remove a required check to get one pull request through. The correct
move for that is the documented bypass, by the actor who owns it, and the pull request that
repairs the check afterwards.
