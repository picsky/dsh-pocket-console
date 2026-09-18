# Decisions

Why the plugin is shaped the way it is, when the answer is not obvious from the
code. A change that contradicts a record here needs a new record, not a quiet edit.

| Record | Decision |
|---|---|
| [0001](0001-no-build-step.md) | Plain ESM, no build step, runtime libraries bundled in the tarball |
| [0002](0002-desktop-mirror-runs-in-the-browser.md) | The desktop mirror runs in the browser, and why the Host cannot do it |
| [0003](0003-a-phone-instruction-is-human-input.md) | An instruction from the phone is human-attributed input |
| [0004](0004-the-client-half-is-one-file.md) | The browser half is one file, because the loader has no relative imports |
| [0005](0005-connected-means-connected.md) | The credential pair is checked against the platform, and `bound` means the connection is up |
| [0006](0006-binding-is-not-up-for-grabs.md) | A direct message binds an unbound deployment, and never re-binds a bound one |
| [0007](0007-prepend-and-race-the-desktop.md) | The answerer prepends, calls `next()` first, and races the desktop |
| [0008](0008-the-log-speaks-the-deployments-language.md) | The deployment log follows the deployment's `locale`, like the cards do |
| [0009](0009-a-channel-is-one-file.md) | A channel is one file, and that file is what the contract is measured in |
| [0010](0010-the-channel-names-its-own-controls.md) | The channel names its own card controls and reports the mapping, because a card may not repeat a name |
| [0011](0011-one-question-per-card.md) | One question per card, and the card steps to the next as each is answered |
