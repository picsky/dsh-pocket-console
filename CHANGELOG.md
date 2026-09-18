# Changelog

Notable changes, newest first. Versions are the published npm versions; each section
names the point in the history it corresponds to, so `git log` can fill in the detail.

The project is pre-1.0: a minor bump can carry a behaviour change, and one is called
out when it does.

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
