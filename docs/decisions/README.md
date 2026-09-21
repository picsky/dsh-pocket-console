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
| [0012](0012-the-desktop-composer-steps-without-the-phone.md) | The desktop composer cannot be advanced per question, and the phone does not try |
| [0013](0013-a-notice-is-remembered.md) | A live notice is kept in durable storage, so a restart re-applies the rules instead of ending them |
| [0014](0014-the-process-binds-every-change.md) | Every change lands as a pull request with the four checks green; the release keeps one documented shortcut, and a tag is a publish |
| [0015](0015-desk-presence-is-the-gateways-request-id.md) | A person is at the desk when a human message carries the gateway's request id, and a page merely being open is not |
| [0016](0016-the-phone-can-start-the-next-task.md) | The phone can start a new session, only in the workspace it is already looking at, and only while it holds the person |
| [0017](0017-the-result-card-carries-the-run.md) | The result card carries the run in a fold, keeping both ends and naming the middle it gave up |
| [0018](0018-the-status-board-is-a-pinned-card.md) | The persistent status board is a pinned card — and one with no controls, so it stays editable |
| [0019](0019-the-next-task-rides-the-result-card.md) | The next task is a form on the result card, and a rewrite may not take the answer away |
| [0020](0020-a-phone-started-session-joins-its-workspace.md) | A phone-started session is created through its workspace, so the desk groups it where it belongs |
| [0021](0021-the-card-you-pressed-is-the-one-that-moves.md) | The card a reply is answered on becomes the run's card, and the next result is a card of its own |
| [0023](0023-a-reply-into-a-running-session-steers.md) | A reply that arrives while the session runs is steered into that turn, not queued behind it |
