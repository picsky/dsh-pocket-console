/**
 * Refuse a pack that would ship without the transport it bundles.
 *
 * `bundleDependencies` embeds whatever `node_modules` holds when the tarball is
 * built, and packing before an install produces a tarball with none of it and
 * no warning — the published plugin would then fail to import its Feishu
 * transport for every user. `prepack` runs for both `pack` and `publish`, so
 * this is where the requirement can be enforced.
 */

import { existsSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const missing = (manifest.bundleDependencies ?? [])
  .filter(name => !existsSync(new URL(`../node_modules/${name}/package.json`, import.meta.url)))

if (missing.length > 0) {
  console.error(
    `verify-pack: ${missing.join(', ')} is listed in bundleDependencies but is not installed.\n`
    + 'verify-pack: run `pnpm install` first — without it the tarball ships without the '
    + 'transport it bundles, and the published plugin cannot import it.',
  )
  process.exit(1)
}
