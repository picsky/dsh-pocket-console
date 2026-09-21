# 0008 — The deployment log speaks the deployment's language

**Status:** accepted.

## Context

Every reader-facing string in this plugin comes from one dictionary (`messages.js`),
chosen by the deployment's `locale` — that was record-worthy enough to build the
dictionary in the first place ([0002](0002-desktop-mirror-runs-in-the-browser.md)
covers the browser half of the same idea). The Host's own log lines were left out of
that, and they drifted into both languages at once:

- `providers/feishu.js` logged about twenty lines in Chinese — the verification link,
  every connection transition, a rejected credential pair;
- `results.js` and `mirror.js` logged in Chinese;
- `escalation.js` and `index.js` logged in English.

So a deployment that had set `locale: en` read its cards in English and its log in
Chinese, and a `locale: zh` deployment read a story split down the middle. Worse, the
Chinese lines named state the English cards had words for — "已绑定接收人" against a
card that said "Bound".

The log is not the phone card. It is read by whoever is diagnosing *this* deployment:
the person who ran it, most often on the same machine, usually right after reading one
of its cards. Splitting the two languages is not a neutral default, it is a papercut on
the one task the log exists for.

## Decision

**Host log lines that describe the deployment come from the same dictionary the cards
do**, keyed `log…` so they are visibly a different audience from the card copy.

**Lines about the plugin's own internals stay English.** `index.js` logs its composition
failures in English — a failed channel resume, a failed priority restore, a missing
`webServer`, a failed channel close — each of which is about the harness's composition
rather than the deployment's state, and routes the one deployment-facing line, a failed
notice restore, through the dictionary. Those are developer diagnostics on the same
footing as the harness's own English log, and
translating them would imply a reader who does not exist.

The split is therefore by audience, not by file: the deployment's story is localized,
the plugin's internals are not.

## Consequences

- A deployment reads one language end to end, in the log and on the phone.
- The dictionary grew by roughly thirty `log…` keys in two languages. That is the real
  cost, and it is why the lines are keyed by a `log` prefix: a reader can see at a
  glance which half of the dictionary they are in.
- A translated log now depends on the `locale` the deployment set — which a deployment
  that never opens the Web UI sets only in configuration. There is no separate
  log-language setting, deliberately: two settings that both mean "what language is
  this deployment in" is a way to have them disagree.
- The suite holds it still: one case asserts an English deployment logs
  `desktop mirror: loaded` with no Chinese line anywhere, and a Chinese deployment the
  reverse.

## Alternatives

**All logs in English**, on the reasoning that logs are developer-facing. Rejected:
this log's most frequent reader is the person who set `locale: zh` and is looking at a
Chinese card on their phone — the person the dictionary was built for.

**Translate only the lines that mention user-visible state** (bound, rejected,
connected). Rejected as the worst of both: a reader would still meet a split language
in one log file, and the rule for which line is which would be invisible from the code.
