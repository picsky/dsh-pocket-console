# 0001 — No build step

**Status:** accepted.

## Context

pnpm ≥11 gates install scripts behind an explicit decision. A plugin installed
from a git URL resolves its own dependencies from the registry, so the install
meets `protobufjs`'s postinstall and stops with `ERR_PNPM_IGNORED_BUILDS`; the
harness only mounts a profile's plugins after a successful install, so the plugin
ends up downloaded and invisible. Publishing the transport inside the tarball
removed that gate for consumers — but only while nothing in the plugin needs
building on their machine.

## Decision

Ship plain ESM JavaScript: no bundler, no TypeScript, no transpile step. Runtime
libraries travel inside the tarball through `bundleDependencies`, and `prepack`
refuses to build a tarball missing one of them.

## Consequences

- Installing the plugin never runs a build script, whoever installs it and
  however it is installed.
- Contracts live in JSDoc and behaviour lives in the suite; there is no type
  checker to catch a mismatch.
- The browser half cannot use relative imports — see [0004](0004-the-client-half-is-one-file.md).

## Alternatives

An optional build step produced by the plugin's own `prepare` script: the script
is itself a gate, so the first install would still stop at pnpm's prompt.
