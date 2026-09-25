/**
 * The DSH-version gate.
 *
 * A release says which DSH versions it was verified against. That is the one fact
 * a reader needs to decide whether a version is for them, and it is the fact that
 * goes stale quietly: a plugin can keep working against the harness it was written
 * for while a newer one removes the service it injects. 0.9.2 is the example this
 * gate exists for — it could not boot the Web UI on 0.1.7 at all, and nothing in
 * its release notes said which harness it had been checked against.
 *
 * Both halves of the release body must carry the line, because the body is the
 * version's section of `RELEASE-NOTES.zh.md` (Chinese, first) followed by the same
 * version's section of `CHANGELOG.md` (English). A section with no DSH version in
 * it fails, and so does a version whose sections do not exist yet — a tag is what
 * publishes, so the gate runs before the publish step rather than after it.
 *
 * Checked at release time rather than on every change on purpose. Which harness a
 * release was verified against is a property of the release: a change under
 * `Unreleased` does not yet know which version will carry it, and the sections of
 * versions released before this rule existed cannot be made to comply after the
 * fact without inventing what they were tested on.
 *
 * Run: npm run check:dsh-version
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')

const version = JSON.parse(read('package.json')).version

/**
 * The section one release's body is assembled from.
 * @param source - the document's text.
 * @param heading - the `## <version>` heading to slice from.
 * @returns the section's text, heading included, or undefined when it has none.
 */
function section(source, heading) {
  const at = source.indexOf(`\n${heading}\n`)
  if (at === -1) return undefined
  const rest = source.slice(at + 1)
  const end = rest.indexOf('\n## ', heading.length)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * Whether a section names the harness it was verified against.
 *
 * Deliberately loose about the wording and strict about the fact: any `DSH` or
 * `dsh` followed by a version number counts, so `DSH 0.1.6-alpha.1`,
 * `DSH 0.1.6-alpha.1 and 0.1.7-rc.2` and `dsh 0.1.5+` all pass, while a section
 * that only talks about the plugin's own version does not.
 */
const NAMES_A_HARNESS = /(?:DSH|dsh)\s+v?\d+\.\d+/

const problems = []
for (const [file, heading] of [['RELEASE-NOTES.zh.md', `## ${version}`], ['CHANGELOG.md', `## ${version}`]]) {
  const body = section(read(file), heading)
  if (body === undefined) {
    problems.push(`${file} has no "${heading}" section: the release body is assembled from it`)
    continue
  }
  if (!NAMES_A_HARNESS.test(body)) {
    problems.push(`${file}: "${heading}" names no DSH version, so the release does not say which harness it was verified against`)
  }
}

if (problems.length > 0) {
  console.error(`check-dsh-version: ${version} is not ready to publish`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('  add a line like "Verified on DSH 0.1.6-alpha.1 and 0.1.7-rc.2." to both sections')
  process.exit(1)
}

console.log(`check-dsh-version: ${version} states the DSH version it was verified against, in both halves of its release body`)
