# Changelog

Notable changes, newest first. Versions are the published npm versions; each section
names the point in the history it corresponds to, so `git log` can fill in the detail.

The project is pre-1.0: a minor bump can carry a behaviour change, and one is called
out when it does.

## Unreleased

### Added

- **The development process is written down, and the repository now enforces it.** A
  contributor-facing *How a change lands* section in `CONTRIBUTING.md` (issue first, branch,
  one topic per pull request, squash merge, the four checks and what each one proves), a pull
  request template that mirrors what a change needs, a feature-request issue form — blank
  issues are disabled, so an idea previously had nowhere to go but Discussions — and a
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) (Contributor Covenant 3.0, with this project's
  own reporting channel and enforcement process in place of the template's two placeholders).
  The maintainer's side lives in `internal/maintaining.md`, which is not published. The
  argument is [0014](docs/decisions/0014-the-process-binds-every-change.md).
- **`main` requires a pull request, and the four checks are not advisory any more.** Required
  checks with no `paths` filter, a linear history, squash-only merges, no force-push and no
  deletion; the repository administrator keeps one documented bypass so a broken workflow can
  still be repaired. Only the maintainer may create a `v*` tag, because a tag is what
  publishes this package. No plugin behaviour changed.
- **The release workflow refuses a tag whose commit CI never judged.** It now asserts that
  the tagged commit is an ancestor of `origin/main` and that all four of its checks concluded
  `success`, and it asks for `checks: read` to do it. Where the ruleset can be bypassed, the
  publish job cannot.
- **Dependabot watches the action pins weekly and the bundled transport monthly**, and
  repository security updates are enabled. There are no devDependencies here, so an npm
  update is always a change to what an installer runs.
- **`npm run check:parity` reads the channel contract too.** `providers/README.md` is the one
  published document outside `docs/`, and it was not being held to the published file list —
  a link from it to something the tarball does not carry would have 404d on the registry with
  the gate reporting success.

### Changed

- **A finished run leaves a record on its card instead of looking live.** When the phone holds the
  person, one card follows a run and is edited in place; when the turn ends the card freezes: the
  status becomes `已结束`, the header goes grey, and the run's own process — what the person asked
  for, what the run said, and the tools that failed — folds into a panel the channel renders
  collapsed and the reader opens in place. A live card folds nothing, because a panel growing under
  a reader's thumb is worse than no panel. The panel is capped: a hundred-step run keeps its end
  rather than its beginning, since the end is what a reader is looking for. A view gains the optional
  `details` field for it, which `providers/README.md` and its Chinese counterpart say a channel
  should fold where it can and must not silently drop (`activity.js`, `providers/feishu.js`).

- **A run in progress is visible from the phone, on a card that is edited rather than sent.**
  A long turn used to be silent: the phone heard from this plugin only when a request blocked or
  a turn ended, so the only way to know whether the machine was still working — and where it was
  — was to go and look at the desk. One card per session now shows the status, the turn and step,
  how long it has been running, the tool it is waiting on, and the newest of the live stream. It
  is sent once and edited after that, because a bot cannot send without notifying and an edit is
  silent; and it carries no controls at all, because a card being interacted with cannot be
  updated and being updated is its whole job. Edits are limited to one per 250 ms, with the text
  deltas accumulated behind them: a long answer produces hundreds of deltas and Feishu allows
  five edits per second to one message, so following every delta would be throttled into being
  permanently behind. The card is minted only once the phone holds the person — while the desk
  does, the run is visible where they already are — and the newest three fragments of the current
  stream are what it carries, since the turn's actual answer is what the result notice is for
  (`activity.js`).

- **The desktop head start now follows the person.** The wait was a constant: the configured
  number of seconds of desk-only time before the channel was used, whatever the person was
  doing. An answer from a phone card is the evidence that nobody is at the desk — the person is
  holding the phone — so from that moment the wait is zero and a card goes out as soon as there
  is one. An answer *at the desk* is the only thing that brings the head start back, because it
  is the only proof that anybody is sitting there; a page being open is not, and nothing about a
  browser being connected moves it. Both timers read the wait through one place, and every
  countdown already running is re-timed on the spot, so a move reaches the requests in flight
  rather than only the next one. The side is durable, because a restart that put a person who is
  away back behind a head start would make the phone go quiet exactly when it is the only surface
  there is. An approval that arrives under phone priority says so on the card, in the same words
  a deployment that configured zero already got (`priority.js`, `escalation.js`, `results.js`).

- **Every phone card now names the workspace of the session it belongs to.** The title carried
  the deployment's prefix and what the card was asking for and nothing else, so several sessions
  running at once produced cards that could not be told apart, and a card that had finished
  looked like a live one. The title is now `DSH 结果 · my-app`: the workspace taken from the
  session header's working directory, and left out entirely for a session that has none rather
  than filled with something invented. It is resolved once, when the card is built, and carried
  on the record that owns it — a card is rewritten as it is answered, superseded or retired, and
  reading the session again at each of those moments would drop the name from a rewrite whenever
  the session had been reclaimed in between. The title is the one part of a card that shows in
  the chat list, so this identifies a card without opening it (`identity.js`).
  A card rewritten when its record is already gone — a press arriving after a restart, or after
  the process dropped the request — is named from what was remembered against the message
  itself, so the card a reader presses is not the one card that cannot say which session it was
  about (`workspaces.js`). A workspace name longer than forty characters is cut on a character
  boundary rather than a code-unit one, so a name ending in an emoji is not left half-written in
  the title.

- **Both READMEs were restructured around the order a reader needs things in.** The entrance is
  now the install, the uninstall, and the three settings the Settings card exposes; security,
  what it deliberately does not do, and how it breaks follow; the comparison with the other
  kinds of plugin moved to the end. The implementation walkthrough — the request diagram,
  `prepend`, `next()`, the race — and the engineering limitations left the README altogether,
  because they are material for whoever changes the code, and that reader now gets five pointers
  instead of prose: `npm test`, the two gates, the decision records, `CONTRIBUTING.md`, and the
  channel contract. The "three things that define it" section is gone, and the expectations it
  carried — desktop first, a single-use decision, outbound only — are stated where they are
  needed: the introduction, the settings table and the security section. Reading order, not
  behaviour: nothing about the plugin itself changed.
- **[`docs/releasing.md`](docs/releasing.md) describes the release that now exists**: the
  version bump and the changelog land as a `Release x.y.z` pull request, and the tag names the
  squash commit once `main` is green. `npm version minor` and `git push --follow-tags`, which
  tagged whatever was checked out locally, no longer describe the flow.
- **`CODE_OF_CONDUCT.md` is part of the published package**, so a reader of the tarball can
  follow it from `CONTRIBUTING.md` rather than meeting a 404.
- **Both READMEs link `CONTRIBUTING.md`**, which neither did before: what a change needs was
  reachable only from the documentation index.

- **Both READMEs were rewritten around what the plugin is not.** The old first line borrowed
  a GUI-mirroring plugin's slogan and promised approval "from anywhere", which is the one thing
  an outbound-only transport cannot offer. The new entry states the position up front, puts
  "which of these is this" and "what it deliberately does not do" in the path of anyone
  choosing between plugins, and moves the implementation walkthrough out of the entrance.
  Nothing about the plugin itself changed. The npm `description` and `keywords` follow the
  same positioning.
- **The answer to "how are several questions shown" is now stated once.** `0.8.0` established
  one question per card ([0011](docs/decisions/0011-one-question-per-card.md)); the README had
  still been describing the older all-questions-on-one-card layout.
- **Both READMEs show the profile-layer example again**, with every key at its shipped value:
  rewriting them had dropped the `$DSH_HOME/profiles/web/cordis.patch.yml` block that used to be
  there, and that copy is the one a reader meets. `npm run check:parity` holds the same example
  in `docs/configuration.md` and `docs/zh-CN/configuration.md`, and the bundle patch, to the
  code's names and defaults.

### Removed

- **The competitive research and the positioning draft are no longer in the repository.** The
  plugin's position now lives in the [README](README.md) itself — the "which of these is this"
  table and the refusals after it — and the research behind it is a working note that goes stale
  within weeks, so `.gitignore` keeps it in the working tree and out of the repository.
  Position is a product decision, not a document to maintain; what survives is the shape of the
  plugin.
- **`docs/README.md` no longer indexes them**, adds the Chinese README to the list of paired
  pages, and stops claiming nine decision records when there are thirteen.

### Fixed

- **A request that arrived while the phone held the person stayed on the phone after they went back
  to the desk.** Phone priority sets the wait to zero so a request does not wait out a head start
  for an empty chair — but a wait of zero means the request *skips* the head start rather than
  shortening it, and nothing could give one back: the re-time that exists for exactly this only
  reaches a request whose card has not gone out. A card the desk let the clock run out on, and a
  card already on the phone, are both left alone — the first is the feature working, and taking the
  second back would put one question in front of two surfaces. What changes is the request that had
  not sent its card yet, which now waits out the head start counted from its own arrival
  (`escalation.js`, `priority.js`).

- **A card the platform refused as too large now arrives anyway, and the size budget measures the
  right thing.** Two separate faults, one visible as no message at all. The budget was counted in
  the text's own UTF-8 bytes, but the text is escaped into the card JSON and the card JSON is
  escaped again to become the request body, and each escape doubles a quote or a backslash — so
  text dense in those, which is what tool output, JSON and code are made of, measured inside the
  budget and left as a 55 KB body against a 30 KB cap. The budget is now counted the way the body
  counts it, and is small enough that a whole card stays inside the cap even if every byte escapes
  twice; it costs length in the ordinary case, about 1,500 Chinese characters rather than 2,700. A
  delivery the platform still refuses for size is retried once at half the text rather than
  repeating an identical attempt forever. An *edit* refused for size was dropped with a log line,
  which left a card showing a stale state for good; it is retried the same way (`budget.js`,
  `activity.js`, `README.md`).

- **A frozen card said everything twice, or lost the end of the run.** A step's text arrives by two
  routes — live stream fragments while it runs, and one committed message when it settles — and the
  record folded both, so the reader got the same words twice; the guard meant to prevent it compared
  the first 40 characters of the text, which could neither tell a repeated opening phrase from the
  same message nor survive either shape changing. Whether the text is already folded is now decided
  by the step numbers the events carry, which is exact. Folding also took the card face's newest
  three fragments rather than the step's whole stream, so a streamed run's beginning was dropped and
  a long sentence could be cut off mid-way; the whole step is folded now. And a card that had frozen
  was still being rewritten by late events from the turn it had closed; it stays frozen now, with a
  queued prompt the one exception, since that opens the *next* turn (`activity.js`).

- **The folded record was unbounded, and a failed tool named the wrong thing.** The running total
  that bounds the record was never initialized, so it was `NaN` from the first entry, every
  comparison against the budget was false, and the record grew with the run — the bound existed only
  on paper. The text folded back in from the live stream is now bounded as it arrives for the same
  reason. Separately, a failed tool's line read its reason from `error.message` and its subject from
  a field that does not exist: `error` carries a name and a code, the prose is in the result's own
  content blocks — which are blocks, not a string — and a result block names only the call id, so
  the tool's name can only come from the call that preceded it. The line could show an error class
  and `[object Object]` where the reason belonged (`activity.js`, `tests/activity.test.mjs`).

- **A retried card can no longer become a second notification.** A send the platform accepted but
  whose answer never came back is the one way one card becomes two messages: this side cannot tell
  "it was sent" from "it was not", so the activity card's retry would deliver it again. Every card
  now carries an idempotency key — the same one for every attempt at that card — and the transport
  makes a repeat of the key resolve to the message it already accepted. Feishu does this with the
  request's own `uuid`, which it holds for an hour. The channel contract gains `deliver(view,
  { uuid })`, optional for a transport with no such mechanism; `providers/README.md` and its
  Chinese counterpart say what a channel must do with it (`activity.js`, `providers/feishu.js`).

- **A composer answered from the phone stayed waiting when the desk was asleep.** A forwarded
  request is finished by a browser answering it, so the phone's answer reaches the model and
  leaves the desktop composer open; the browser half is what closes it. That half gave up on a
  decision after one attempt, so a page that had only just loaded — no composer mounted yet —
  wrote the decision off, and the composer was stuck from then on with nothing able to close it.
  A decision that could not be applied now stays on offer and is retried, and only an attempt
  that actually moved a composer ends it (`client.js`). The other half of the same gap was
  invisible: when the mirror window passed before any browser collected the decision, the Host
  simply stopped offering it, so nothing anywhere recorded that one decision ended with a
  composer left behind. A lapsed decision is now offered once more, marked `expired`, so a late
  poll can see what happened, and the Host logs the lapse (`mirror.js`, `client.js`). The
  deployment log gains one line, `logMirrorLapsed` / 有一条手机决定…过期了, and the browser half
  gains one report, `lapsed`.
- **A saved change to the desktop head start did not move a countdown that was already
  running.** The wait was read once, when the request arrived, so an edit reached the next
  request and not the one the reader was looking at when they made it — which reads as a
  setting that did not save, and the next move is to restart `dsh`, which withdraws every
  outstanding notice for nothing. A request still waiting for its card, and a session still
  inside its calm window, are now re-timed against the value in force, counting from when they
  started: a request that has waited 100 of 120 seconds and meets a 20-second value goes out
  now rather than after another 20 (`escalation.js`, `results.js`, `index.js`).

## 0.8.1

**Nothing about the plugin changed.** This release exists so that the tag names the tree the
published artifact was built from. 0.8.0's tag carries two edits made *after* it was published —
the release workflow and `docs/releasing.md` — and the second of those is inside the package, so
the tag and the tarball disagreed by one file. Publishing the tree as it now stands makes the tag,
the artifact, and the workflow that produced them one commit, and it is the first release this
repository's workflow has published end to end.

## 0.8.0

### Changed

- **A request with several questions is now asked one question per card, and the card steps
  to the next as each is answered.** Every question used to be rendered into one card, and
  because a card puts its text blocks first and its controls after them, the reader got all
  the questions' text and then all the questions' buttons below it — one identically worded
  typed-answer box per question, with nothing to say which was which. Answered questions stay
  on the card as a receipt and the title names the position (`提问 · 第 2/4 题`). This is the
  rhythm the desktop composer already steps through (`escalation.js`, `messages.js`). See
  [0011](docs/decisions/0011-one-question-per-card.md).

### Fixed

- **A result notice died with the process that sent it.** Live notices were held in memory, so
  restarting dsh withdrew every outstanding one and the card blamed an expiry that never
  happened — a notice is documented as having no time limit, and coming back to it later is the
  feature. They are kept in the durable storage hub now, and a restart re-applies the rules that
  actually retire one: the session may have been deleted, or somebody may have spoken in it while
  dsh was down, which is settled against the session's own log rather than assumed. A notice
  answered before the restart is not offered again — the record is deleted the moment the rid is
  used (`notice-store.js`, `results.js`). A press arriving before the durable medium has answered
  no longer retires the card it came from: at that moment this side has not finished looking, and
  discarding an offer that is still valid is the one thing the record exists to prevent. See
  [0013](docs/decisions/0013-a-notice-is-remembered.md).
- **A card whose request no longer existed stayed answerable.** Live requests are held in
  memory, so after a restart — or a crash — the card on the phone had nothing behind it:
  pressing a button produced a toast saying the request was gone and the card went on offering
  the same buttons for good. A press carries the message it came from, so the card is now
  rewritten where it lies with its controls removed, for question cards and for result notices
  alike (`escalation.js`, `results.js`, `index.js`). A channel must therefore report the message
  a press came from (`providers/README.md`).

## 0.7.9

### Fixed

- **A request carrying several questions was refused by the platform, so the card never
  arrived.** A card may not hold two elements of the same name, and the core names every
  question's controls `value` and `custom` — so a three-question card held three elements
  called `value` and Feishu rejected the whole document. The failure reached the reader as
  no message at all. Each form's controls are namespaced now, and the submit reports the
  names the card used so the core reads the answer back (`providers/feishu.js`,
  `escalation.js`, `results.js`). A card sent before that report existed is still read
  under the core's names, so answers already sitting in a chat keep working. See
  [0010](docs/decisions/0010-the-channel-names-its-own-controls.md).

## 0.7.8

**0.7.8 is an accidental duplicate of 0.7.7 and should not be used.** It was published by
hand from a working tree whose version had been bumped but never committed, so it carries no
change of its own: its 1152 files are byte-for-byte 0.7.7's apart from the version string,
which is what comparing the two tarballs shows. No tag points at it, because no commit
describes it. Preparing *this* release as 0.7.8 then failed on the duplicate, which is why
it is 0.7.9 — see [releasing.md](docs/releasing.md) for how a hand publish lets a version
number escape the workflow's tag check.

## 0.7.7

### Fixed

- **A terminal handshake failure left the card's retry doing nothing.** The failure
  handler published `failed` but kept the dead transport, and `beginEnrollment` treats a
  live transport as work already done — so pressing retry returned the same failure
  without connecting. The connection is now given up with the attempt, and it is
  published before `start()` is called, because that is where the error arrives
  (`providers/feishu.js`).
- **A malformed or oversized request body was reported as a 500.** It is the caller's
  mistake and is now a 400, which also stops a genuine server fault from being buried
  among ordinary client errors (`routes.js`).
- **`clipToBytes` could return more than the budget it was given** when the clip marker
  was wider than that budget — a bound that silently did not hold. The marker is what
  gets clipped in that case (`budget.js`).
- **A result notice's reply id came from `Math.random()`** while the escalation registry
  used `randomUUID()` for the same job. Both draw from the platform CSPRNG now, since
  that id is what decides whether a reply is accepted (`results.js`).
- **A request could hang forever when the card could not be delivered.** The
  escalation gave up on the phone by settling its own race with no answer, which
  left the desktop branch — the one that was still authoritative — never consulted.
  It now abandons the phone side and lets the desktop decide
  (`escalation.js`).
- **The settings card could wedge on a rejected write.** A revision conflict or a
  read-only document rejected out of the save before the in-progress flag came
  down, leaving "Saving…" with both buttons disabled until a reload
  (`client.js`).
- **A pending decision could be applied to the wrong interaction.** An approval
  carries no question ids, so the mirror's match accepted *any* pending composer in
  the page. Approvals now match on their session and are refused for a composer
  that is asking a question (`client.js`).
- **The mirror could retry a failed apply once a second, forever**, and every tab
  re-applied the same decision. An attempt is made once per page, a synchronous
  throw counts as a skip, and the Host withdraws a decision once a page reports it
  applied (`client.js`, `mirror.js`).
- **`starting` rendered no controls at all**, so a slow handshake left the card with
  nothing to press. It offers **Unbind** (`client.js`).
- Enrollment could be started twice by two overlapping clicks, creating two apps and
  leaving a live connection with no reference to close it
  (`providers/feishu.js`).

### Security

- **A direct message from any account could take over the binding**, and with it
  every approval card and the authority to answer one. Binding now happens only from
  an unbound deployment, only in a direct message; a group message never binds, and a
  bound deployment refuses other accounts. See
  [ADR 0006](docs/decisions/0006-binding-is-not-up-for-grabs.md).
- A credential check that failed for an unrecognized reason could delete a working
  pair from the store. Only a refusal the platform actually produced discards
  credentials now (`providers/feishu.js`).
- The channel reported itself available before its handshake completed, so requests
  could be escalated to a phone that could receive a card but not return a press
  (`providers/feishu.js`).

### Changed

- Adopting another app clears the recipient learned from the previous one: Feishu
  scopes an `open_id` to the app that resolved it, so the old id addressed nobody.
- A failure message on the card is composed from the copy dictionary instead of
  carrying the raw SDK error (`providers/feishu.js`).
- The settings card's own strings are translated: the pending suffix, the QR code's
  accessible name, and the request-failure text. An unrecognized enrollment state
  says so rather than claiming "Not bound" (`client.js`).
- **The settings card reads the page's language on every render**, instead of holding
  whatever was active when the bundle loaded. Switching the interface language used
  to leave the card behind while the state report already claimed the new one, so the
  card and the phone it escalates to could disagree. One reader now serves both, and
  the language reported to the Host is the one the card actually rendered in, so the
  two cannot drift even when the page names no language at all. The card carries its
  own poll, so a switch appears within about three seconds without a reload
  (`client.js`).
- `check-parity` now compares documented defaults, not only field names, and refuses
  a published document that links to a file the package does not publish — and refuses
  a **relative** image in either root README, because npm re-hosts only what the tarball
  carries and `assets/` is deliberately not in it: a relative path renders on GitHub and
  404s on the package page. Both READMEs now carry the absolute form, including inside
  the commented insertion points, so the block is correct the day it is uncommented.
- **The deployment's log now follows the deployment's language.** Host log lines that
  describe the deployment — the verification link, every connection transition, a
  rejected pair — come from the same dictionary the cards do, instead of being Chinese
  in some files and English in others. Lines about the plugin's own internals stay
  English, because they describe the harness rather than the deployment
  ([ADR 0008](docs/decisions/0008-the-log-speaks-the-deployments-language.md)).
- **Two accessibility gaps on the settings card**: the header's accessible name now
  repeats the "unsaved" badge it shows (a label replaces the button's text, so a badge
  it omitted was a state nobody heard), and the enrollment row is a polite live region,
  because that state moves on its own — `starting` → `bound` — with nobody pressing
  anything (`client.js`).

### Documentation

- **How it works now carries a sequence diagram**, which is the one view that shows the
  ordering the prose kept having to re-explain: `next()` is called before anything
  else, and the phone is reached by a timer rather than by default. Both READMEs have
  it, and every mermaid block in the repository was checked with mermaid's own parser
  (including the Chinese participant aliases).
- **The configuration page documents the binding state machine**, because "which wait is
  this card in" is the question a stuck card raises and the states are otherwise only
  visible in the provider's source.
- `docs/releasing.md` and `docs/development.md` said a setting lives in five places; the
  gate has covered six since the config tables moved to their own pages.
- `internal/launch.md` now carries the launch **bodies**, not just the channel list —
  ready-to-paste text for the Show and tell post, the registry PRs, the two Chinese
  boards, Show HN, and a media pitch, plus a reply bank for the three questions every
  launch gets. Every claim in them is checkable in this repository.
- `internal/release-readiness.md` records the ten checks the release path depends on and
  what each one returned, so none of them has to be re-discovered on release day.
- Added [ADR 0009](docs/decisions/0009-a-channel-is-one-file.md), which records why a
  channel is a single file — the shape a second transport is expected to copy — and
  what would change it. ADR 0004 covered the browser half only; the provider's length
  was undocumented.
- Corrected the documented defaults for `resultNotify` (`idle`) and
  `resultNotifyCooldownSeconds` (`0`), and the examples that disagreed with both.
- Removed `maxDetailChars` from both examples: byte budgeting replaced it, and the
  key does not exist.
- Reconciled the README with [ADR 0005](docs/decisions/0005-connected-means-connected.md)
  on the credential check's verified paths, and added `SECURITY.md`.

## 0.7.6

Answer the click, re-read the settings, and stop printing the SDK's log. A card
action that arrives with nothing behind it says so; a settings change takes effect
on the next decision instead of needing a restart; the Feishu SDK's startup banner
and per-step chatter are routed into the deployment's debug log.

## 0.7.5

Report a connection only when it is up, and pack with the tool that publishes.
`bound` is published by the SDK's ready callback rather than by `start()` returning,
so a rejected pair can no longer look like a working one.

## 0.7.4

Bind an existing bot with its credentials, which is what binding never needed a scan
for. **Use an existing app** takes an App ID and App Secret, checks them against the
platform, and connects with them.

## 0.7.3

Name the app being bound: the launch page only learns the app from the id it is
carried with.

## 0.7.2

Offer both ways to bind, drop the button that did nothing, and use the platform's
dialog for both confirmations.

## 0.7.1

Release 0.7.1.

## 0.7.0

Card text is bounded in **bytes** and a card the platform refuses for size is
retried once, smaller — a Chinese character costs three bytes, so a character limit
would have meant three times the payload. Every card string moves into one
dictionary, so the phone follows the deployment's language. The escalation
lifecycle, the mirror record, and the route table each move into their own module,
and the reasons behind the shape of the plugin are recorded in `docs/decisions/`.

## 0.6.1

The routes sit behind the connection's trust fence, and only the bound recipient's
press is honoured. The browser half can carry a multi-select answer with text beside
its choices, and the card gets the chrome, fields, and pending detail it lacked.

## 0.6.0

A session that stops sends its answer to the phone with a box to reply in, and the
instruction enters the session as the reader's own message. A notice stops accepting
replies the moment it stops being the session's latest word, and each session's
composer panel is reported separately.

## 0.5.x

The desktop mirror: a phone answer is applied to the open page's composer through the
same client call a click makes, and every attempt is reported so a mirror that is not
landing says which step it reached. The five places one setting lives in are gated
against each other by `check-parity`.

## 0.1.0 – 0.4.x

Forward tool approvals and `ask_user_question` prompts to the phone. Published through
a trusted publisher with no stored token, with the transport bundled into the tarball
so an install resolves nothing that needs a build permission.

## Before 0.1.0

Card actions were read from the wrong envelope field, so every press answered
"already handled or expired". Upgrade if that is the version in your profile.
