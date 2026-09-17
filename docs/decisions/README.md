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
