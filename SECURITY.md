# Security policy

`dsh-pocket-console` is a **remote authorization channel**. An approval card is a
grant that lets a tool call proceed, and the phone answer becomes human-attributed
input inside the session. A hole in this plugin is therefore not "a plugin bug" —
it is a way to authorize actions on someone else's machine, so reports are taken
seriously and handled before anything else in the backlog.

## Reporting a vulnerability

**Use GitHub's private reporting, not a public issue:**
[Security → Report a vulnerability](https://github.com/picsky/dsh-pocket-console/security/advisories/new).

That channel keeps the report private while it is worked on, and it is where the
advisory and the fix are published afterwards. Please do not open a public issue,
a discussion, or a pull request for anything you believe is exploitable.

Helpful in a report:

- what an attacker gains, and what they have to be able to do first;
- the version (`npm ls dsh-pocket-console`, or the tag) and your `dsh --version`;
- whether the app was created through the one-scan flow or adopted from an existing
  app, since the two carry different scopes;
- log lines prefixed `pocket-console:` — **with any App Secret, verification link,
  or `open_id` removed**. A verification link is a live single-use credential.

Do not test against someone else's Feishu tenant, and do not use a real secret you
cannot rotate.

## What is in scope

- The plugin's own halves: `index.js`, `client.js`, `escalation.js`, `results.js`,
  `routes.js`, `mirror.js`, `budget.js`, `messages.js`, `providers/feishu.js`.
- Anything that lets someone other than the bound recipient answer a request, see a
  card's contents, read a secret, or take over the binding.
- Anything that lets a crafted tool name, reason, or question text escape the card
  it was rendered into.

## What is not in scope

- **DeepSeek Harness itself**, or how it decides which calls need approval. Report
  those to the harness project. A tool call that needs no approval is a policy
  question, not a plugin vulnerability.
- **Feishu / Lark platform behaviour.** Please report those to the platform.
- **Anything that requires the attacker to already control the `DSH_HOME`
  directory.** The credential store is trusted input: whoever can write
  `$DSH_HOME/.credentials.yaml` can already bind a recipient or replace the app.
- Known and documented limits, which are in the README's *Limitations* section
  rather than vulnerabilities — for example that a phone answer needs an open
  desktop page to be mirrored onto it.

## Security properties this plugin claims

These are the invariants a report should be measured against. If one does not
hold, it is a bug:

- **A press is honoured only from the bound recipient.** The channel compares the
  callback's `operator.open_id` against the recipient and refuses everyone else
  *before* the answer reaches the core.
- **The binding is not up for grabs.** A direct message binds an unbound
  deployment and never re-binds a bound one; a group message never binds. See
  [ADR 0006](docs/decisions/0006-binding-is-not-up-for-grabs.md).
- **A grant is one-shot.** `allowed-once` applies to the call that asked, keyed by
  a random id that dies the moment the request settles.
- **An answer must be one the request offered.** A label no option carried is
  refused; a question id that is not in the request is refused.
- **Secrets live in the credential store**, never in the process environment and
  never in `enrollmentState()`.
- **Every route sits behind the connection's trust fence**, with the `Origin` check
  as the fallback when a deployment composes no connection.
- **The app asks for the minimum.** The one-scan flow adds exactly three scopes,
  one event, and one callback to the minimal preset.

## Supported versions

Fixes land on `main` and are published to npm; there are no maintained back-branch
releases, so the version to be on is the latest published one. Check the published
version with `npm ls dsh-pocket-console`.

Two boundaries are worth knowing when you are deciding whether to upgrade:

- **Before 0.1.0**, card actions were read from the wrong envelope field, so every
  press answered "already handled or expired".
- **Binding and the connection report** took their current shape across 0.7.4–0.7.6
  (adopting an existing app, the credential check that names a rejected pair, and
  `bound` meaning the connection is up — [ADR 0005](docs/decisions/0005-connected-means-connected.md)).
