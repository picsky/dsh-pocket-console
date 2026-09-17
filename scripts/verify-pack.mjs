/**
 * Refuse a pack that would ship a plugin that cannot start.
 *
 * Two ways a published tarball can be broken without a warning:
 *
 * 1. `bundleDependencies` embeds whatever `node_modules` holds when the tarball
 *    is built, and packing before an install produces a tarball with none of it —
 *    the plugin then cannot import its Feishu transport.
 * 2. A runtime module that `files` does not cover is simply absent from the
 *    tarball, so the installed plugin fails to import it. A new module is one
 *    line away from that mistake, which is how `messages.js` first shipped.
 *
 * `prepack` runs for both `pack` and `publish`, so this is where both are
 * enforced.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const missingBundles = (manifest.bundleDependencies ?? [])
  .filter(name => !existsSync(join(root, 'node_modules', name, 'package.json')))

if (missingBundles.length > 0) {
  console.error(
    `verify-pack: ${missingBundles.join(', ')} is listed in bundleDependencies but is not installed.\n`
    + 'verify-pack: run `pnpm install` first — without it the tarball ships without the '
    + 'transport it bundles, and the published plugin cannot import it.',
  )
  process.exit(1)
}

// Every relative import a published file makes must resolve inside the tarball.
const published = manifest.files.filter(entry => entry.endsWith('.js'))
const uncovered = []
for (const entry of published) {
  const source = readFileSync(join(root, entry), 'utf8')
  for (const match of source.matchAll(/from '(\.\.?\/[^']+)'/g)) {
    const target = resolve(dirname(join(root, entry)), match[1])
    const relative = target.slice(root.length + 1).replaceAll('\\', '/')
    if (!existsSync(target)) uncovered.push(`${entry} imports ${match[1]}, which does not exist`)
    else if (!manifest.files.includes(relative)) uncovered.push(`${entry} imports ${relative}, which files does not publish`)
  }
}

if (uncovered.length > 0) {
  console.error('verify-pack: the published payload would be closed over a missing module:')
  for (const problem of uncovered) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`verify-pack: ${published.length} published modules close over their relative imports`)
