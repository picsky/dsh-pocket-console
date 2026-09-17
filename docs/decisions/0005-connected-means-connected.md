# 0005 — Connected means connected, and a rejected pair is a reason

**Status:** accepted.

## Context

An app id and secret are the only thing the channel connects with, so the card has
to answer two questions about them: *are they usable*, and *is the connection up*.
Neither could be answered by the transport.

`Lark.WSClient.start()` validates the app id against `/^cli_[0-9a-fA-F]{16}$/` and
returns **silently** when it does not match; otherwise it launches a handshake and
resolves in about 30 ms, long before the handshake settles. A handshake the platform
rejects for bad credentials is **retried**, not surfaced: a live probe with a bogus
pair produced `code: 1000040343`, a reconnect loop, and no `onError` within 12
seconds — `getConnectionStatus()` stayed at `connecting`. The old code published
`bound` the instant `start()` returned, so a deployment bound to a wrong secret
looked identical to a working one, and "did it connect?" had no answer at all.

## Decision

**The pair is checked against the platform before anything connects.**
`POST /open-apis/auth/v3/tenant_access_token/internal` takes the app id and secret
directly — the same pair the long connection authenticates with — and answers `code`
plus the platform's own reason. That reason reaches the card in the deployment's
language for the codes whose meaning was observed; anything else keeps the platform's
wording.

The request goes through the SDK's own client, with an API **path**. `domain` is that
SDK's numeric enum (`Domain.Feishu` is `0`, `Domain.Lark` is `1`), and the client is
what turns it into the platform to ask: interpolating it into a URL produced
`Failed to parse URL from 0/open-apis/auth/v3/…`. The test stub had been answering
`Domain.Feishu === 'feishu'`, so the suite agreed with the mistake; it now carries the
real enum, resolves the origin the way the SDK's `formatDomain` does, and refuses a
request whose `url` is not a path.

**`bound` is published by the SDK's ready callback**, never by `start()` returning.
The connection state is republished on reconnect and on a terminal error, so a dropped
tunnel is visible rather than implied. A handshake that has not settled within 30
seconds says so and keeps trying, instead of reading as success or as failure.

**A rejected pair is not kept.** It is removed from the credential store, so the next
start does not retry it and report the same failure with nobody having asked. A pair
that could not be *checked* is kept: an unreachable platform proves nothing.

**Credentials belong to the connection that was opened with them.** Adopting another
app closes the previous connection instead of leaving the old app receiving while the
card names the new one.

## Consequences

- The card shows the app, the recipient, and whether the connection is up. Silence is
  no longer a state the reader has to interpret.
- A store that refuses the write (the reference is shadowed by the process
  environment, or the document is read-only) no longer fails the binding: the typed
  pair connects this session and the card says it could not be kept.
- The preflight costs one request per connection attempt, and needs `open.feishu.cn`
  reachable for a **first** connection — which the one-scan flow already required.
- Both branches were observed against the live platform before this shipped: a pair
  the platform refuses (`code: 10014, msg: app id not exists`, localized) and a real
  app pair from this machine's credential store (check accepted → long connection
  ready → `bound` with its stored recipient). Codes with no observed meaning are not
  mapped: a guessed mapping would put a wrong reason on the card.
- The browser half and the Host half are replaced separately, so a page can call a
  route the running process does not have. The card names that case — restart
  `dsh web` — instead of showing the bare 404 it used to, and CI's composition check
  now proves every route the card calls exists on the host that serves it.
