/**
 * What the plugin may need before the harness can import it at all.
 *
 * `package.json` declares the Feishu transport in `bundleDependencies`, and pnpm resolves no
 * bundled dependency of a git dependency: `dsh plugin --profile web add
 * github:picsky/dsh-pocket-console` installs the repository with **no `node_modules` at all**,
 * and every specifier the plugin makes is then unresolvable except the harness's own. An entry
 * that imports one of them *statically* is not a plugin missing one feature — it is an entry the
 * harness cannot import, reported as `pocket-console (dsh-pocket-console): failed to import` and
 * nothing else, so the whole plugin is absent and the two lines that would have explained it are
 * the only two lines there are.
 *
 * Measured, not imagined: on 2026-09-26 a real `github:picsky/dsh-pocket-console` install into a
 * scratch `DSH_HOME` produced exactly those two lines, the entry was absent from the composed
 * tree, `routes.js`'s `import QRCode from 'qrcode'` was the specifier that failed, and adding the
 * transport to that same profile made the same install activate. The walk below is the invariant
 * that keeps the entry importable; it is deliberately about **static** imports only, because
 * `providers/feishu.js` imports the same transport from inside the channel, which `apply` reaches
 * dynamically and can report as a channel failure in a sentence.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refuse } from './fixtures/stubs/qrcode.mjs'
import { SAME_ORIGIN, requestBinding, scaffold } from './support/harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundled = new Set(manifest.bundleDependencies ?? [])

/**
 * Every static import specifier one module names.
 *
 * `import(...)` is left out on purpose: a dynamic import is allowed to fail, which is the whole
 * difference this file is about.
 * @param source - the module's text.
 * @returns the specifiers, in source order.
 */
const staticImports = (source) =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s*'([^']+)'/g)].map((match) => match[1])

test('the entry imports without a bundled dependency present', () => {
  const reachable = new Map()
  const queue = ['index.js']
  const needingABundle = []

  while (queue.length > 0) {
    const file = queue.shift()
    if (reachable.has(file)) continue
    const specifiers = staticImports(readFileSync(join(root, file), 'utf8'))
    reachable.set(file, specifiers)
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        queue.push(relative(root, resolve(dirname(join(root, file)), specifier)).replaceAll('\\', '/'))
      } else if (bundled.has(specifier)) {
        needingABundle.push(`${file} imports ${specifier}`)
      }
    }
  }

  // A walk that stopped at `index.js` would pass this case while proving nothing, so the reach is
  // pinned: the entry's graph is the one `dsh` walks to give the entry a fiber.
  assert.ok(
    reachable.size >= 14,
    `the walk reached ${reachable.size} modules, too few to be the entry's own graph`,
  )
  assert.deepEqual(
    needingABundle,
    [],
    'a bundled dependency reached statically costs the whole entry on a git-hosted install',
  )
})

test('an encoder that cannot render costs the image and says so, not the plugin', async () => {
  const { route, warnings } = await scaffold()
  await requestBinding(route)

  const encoderWarnings = () => warnings.filter((error) => /qrcode/.test(String(error?.message)))

  refuse.next = true
  const captured = await route('GET', '/__pocket/qr.svg', SAME_ORIGIN)

  assert.equal(captured.status, 503, 'a code that cannot be drawn is an unavailable resource')
  assert.match(JSON.parse(captured.body).error, /unavailable/)
  assert.equal(encoderWarnings().length, 1, 'the deployment log carries the reason instead')

  // The card re-reads its image on every render, so the warning belongs to the failure, not to
  // the request: a log line per poll would bury the one that matters.
  refuse.next = true
  await route('GET', '/__pocket/qr.svg', SAME_ORIGIN)
  assert.equal(encoderWarnings().length, 1, 'and the reason is said once, not once per render')
})
