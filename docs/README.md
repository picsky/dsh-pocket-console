# Documentation

Reference pages, guides, and the decision records. The [README](../README.md) is the
introduction; this is where to go once you have a specific job.

## If you want to…

| Job | Read | Also in Chinese |
|---|---|---|
| **Run it** | [Quick start](../README.md#quick-start) — install, bind, first approval | ✅ |
| **Change a setting** | [configuration.md](configuration.md) — every field, its default, and which ones the Settings card writes at runtime | [中文](zh-CN/configuration.md) |
| **Fix something** | [troubleshooting.md](troubleshooting.md) — installing, binding, and cards that do not arrive, in the order you meet them | [中文](zh-CN/troubleshooting.md) |
| **Work on the code** | [development.md](development.md) — the suite, the real-composition check, and debugging a live deployment | — |
| **Cut a release** | [releasing.md](releasing.md) — the one-time npm setup, what the tag workflow checks, and how to publish by hand | — |
| **Write a transport** | [providers/README.md](../providers/README.md) — the channel contract, and the security duties it puts on a channel | [中文](zh-CN/providers.md) |
| **Understand a choice** | [decisions/](decisions/) — nine records of why the plugin is shaped the way it is | — |
| **Check a claim** | [SECURITY.md](../SECURITY.md) — the invariants this plugin asserts, and how to report a hole in one | — |
| **See what changed** | [CHANGELOG.md](../CHANGELOG.md) — what each release carried | — |
| **Contribute** | [CONTRIBUTING.md](../CONTRIBUTING.md) — what a change needs before it lands, and the rules this repository holds itself to | — |

## Language

Three pages are paired with a Chinese counterpart, and both halves are updated together:
[configuration](configuration.md), [troubleshooting](troubleshooting.md), and the
[channel contract](../providers/README.md). Everything else here — this page,
`development`, `releasing`, the decision records — is English only, on the same reasoning
that the source, the commit messages, and the issue tracker are: one copy to keep true.

A Chinese page appearing in an otherwise English set is a defect, not a precedent. If you
want a page translated, [open an issue](https://github.com/picsky/dsh-pocket-console/issues)
rather than working around it.

## The decision records

[`decisions/`](decisions/) is the repository's own account of the choices that are not
readable from the code — the prepend-and-race ordering, why the browser half is one file,
why a direct message binds but never re-binds. Each record states its context, the
decision, its consequences, and the alternatives that were rejected.

They are load-bearing rather than decorative: a change that contradicts a record needs a
new record, not a quiet edit, and `CONTRIBUTING.md` says so. If you are about to change
something and cannot find a record explaining why it is the way it is, that is worth an
issue.
