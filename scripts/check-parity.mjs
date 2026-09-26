/**
 * Field-parity gate.
 *
 * One user-tunable setting lives in six places: the plugin `Config`, the
 * `SectionSchema` the Settings card is built from, the card's own `FIELDS`, the
 * config table in each language's configuration page, and the commented example in
 * `cordis.patch.yml`. A field that reaches only some of them fails silently — an
 * unlisted key is a setting nobody can find, and a table that names a *different
 * default* than the code ships is worse than no table at all, because it is read as
 * a promise.
 *
 * So this gate holds three things, not one: that the six places name the same
 * fields, that they agree on what each field defaults to, and that the documents the
 * package publishes only link to files it also publishes. The last one is the same
 * class of mistake as the first two — a link a reader cannot follow is a doc that
 * disagrees with reality, and npm renders the README with its links intact.
 *
 * Text is parsed rather than imported on purpose: the gate must not depend on
 * the plugin loading, and a source whose fields it cannot find fails loudly
 * instead of comparing two empty sets.
 *
 * Run: npm run check:parity
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')

const problems = []
/** Report one disagreement between places that must agree. */
const fail = (message) => { problems.push(message) }

/**
 * Read one call's argument, counting brackets so a value that contains its own
 * parentheses — `new URL(x, import.meta.url)`, an object literal — survives whole.
 * @param source - the text being scanned.
 * @param from - index of the `(` that opens the call's arguments.
 * @returns the argument text, or undefined when the call is unterminated.
 */
function callArgument(source, from) {
  let depth = 0
  for (let index = from; index < source.length; index += 1) {
    const character = source[index]
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return source.slice(from + 1, index)
    }
  }
  return undefined
}

/** A schema field and its default, as written in `index.js`. */
function schemaFields(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`check-parity: ${marker} not found`)
  const end = source.indexOf('\n})', start)
  if (end === -1) throw new Error(`check-parity: ${marker} has no closing brace`)
  const block = source.slice(start, end)
  // A leaf may be wrapped in one call of its own — `liveField(z.natural()…)` marks
  // the field the 0.1.7 settings form may edit in place — so the `z.` that proves
  // this line is a schema sits one optional call in, not necessarily right after
  // the colon. Anything else at this indentation is still not a field.
  return [...block.matchAll(/^ {2}([A-Za-z][\w]*): (?:(liveField)\(|[A-Za-z][\w]*\()?z\.[^\n]*/gm)].map((match) => {
    const defaults = [...match[0].matchAll(/\.default\(/g)]
    // The last `.default()` is the effective one: `z.string().default(a).default(b)` ships b.
    const last = defaults.at(-1)
    const argument = last === undefined
      ? undefined
      : callArgument(match[0], last.index + last[0].length - 1)
    return {
      field: match[1],
      // The marker the Host reads is written by `liveField`, so the wrapper *is* the
      // declaration of "this field is editable in the settings form". A field is
      // required to have a default when marking it would otherwise leave the form
      // unready, which is what `requiredWithoutDefault` is for.
      volatile: match[2] !== undefined,
      required: /\.required\(\)/.test(match[0]),
      ...(argument === undefined ? {} : { default: normalize(argument) }),
    }
  })
}

/** The config keys the card edits, read from a list the loader can also read. */
function clientFields(source) {
  const start = source.indexOf('const FIELDS = [')
  if (start === -1) throw new Error('check-parity: client.js has no FIELDS list')
  // The list closes at the statement's own indentation; a nested `options: [`
  // closes earlier, so the first `]` is not the end of the array.
  const end = source.indexOf('\n    ]', start)
  if (end === -1) throw new Error('check-parity: client.js FIELDS list has no end')
  const block = source.slice(start, end)
  return [...block.matchAll(/\{ field: '([^']+)'(?:, kind: '([^']+)')?/g)].map(match => ({
    field: match[1],
    kind: match[2],
  }))
}

/**
 * The `key: value` pairs of one YAML code block, at the depth of `config:`.
 *
 * A commented-out line is a setting a deployment *may* add, so it is read too —
 * and a *nested* object, such as `channelConfig`, is skipped whole: its keys
 * belong to the channel, which owns and validates them, and holding them to the
 * plugin's own schema would fail the gate for a correctly placed setting.
 * @param source - the README's text.
 * @param label - which document, for the failure message.
 * @returns one entry per key named directly under `config:`.
 */
function readmeExample(source, label) {
  const at = source.indexOf('$DSH_HOME/profiles/web/cordis.patch.yml')
  if (at === -1) throw new Error(`check-parity: ${label} has no profile-layer example`)
  const fence = source.slice(at).indexOf('```yaml')
  const end = source.indexOf('```', at + fence + 7)
  if (fence === -1 || end === -1) throw new Error(`check-parity: ${label} has an unterminated example`)
  const lines = source.slice(at + fence + 7, end).split('\n')
  const keys = []
  let depth = null
  for (const line of lines) {
    const trimmed = line.trim().replace(/^#\s*/, '')
    const entry = /^([a-zA-Z][\w]*):\s*(.*?)\s*(?:#.*)?$/.exec(trimmed)
    if (entry === null) continue
    const indent = line.match(/^\s*/)[0].replaceAll('\t', '  ').length
    if (depth === null || indent < depth) {
      if (entry[1] === 'config') { depth = indent; continue }
      // Outside `config:` — the row's own `id`, an inserted `channel:` — until
      // one is found, so a block without one reads as no keys rather than all.
      if (depth === null) continue
    }
    if (depth === null || indent !== depth) continue
    keys.push({ field: entry[1], value: entry[2] })
  }
  return keys.map(entry => ({ field: entry.field, default: normalize(entry.value) }))
}

/**
 * The plugin's own table rows, as `field → default` with the default's backticks
 * stripped. The first table under the given header is the one counted.
 * @param source - the README's text.
 * @param label - which document, for the failure message.
 * @param header - the table header that identifies the config table.
 * @returns one entry per row, with `value` absent when the cell names no default.
 */
function readmeTable(source, label, header) {
  const at = source.indexOf(header)
  if (at === -1) throw new Error(`check-parity: ${label} has no config table (${header})`)
  const rows = []
  for (const line of source.slice(at).split('\n').slice(2)) {
    const row = /^\|\s*`([^`]+)`\s*\|([^|]*)\|/.exec(line)
    if (row === null) break
    const cell = row[2].replaceAll('`', '').trim()
    // `—` and `see source` are the table saying it states no default; a documented
    // default is the only thing this gate can hold the code to.
    const stated = /^(—|-|)$/.test(cell) || cell === 'see source' ? undefined : normalize(cell)
    rows.push({ field: row[1], default: stated })
  }
  return rows
}

/** The example in the bundle patch, at `config:` depth. */
function patchExampleFields(source) {
  const keys = [...source.matchAll(/^# {7}([a-z][\w]*):(.*)$/gm)].map((match) => ({
    field: match[1],
    // The example's prose is in `#` comments on the same line, so a value is
    // whatever precedes the first one.
    default: normalize(match[2].split('#')[0]),
  }))
  if (keys.length === 0) throw new Error('check-parity: cordis.patch.yml shows no example keys')
  return keys
}

/**
 * One default as a string two spellings agree on: the code writes `'idle'`, the
 * table writes `idle`, and both are the same value.
 * @param text - the literal as written in its source.
 * @returns the comparable form, or undefined when the source states none.
 */
function normalize(text) {
  if (text === undefined) return undefined
  const trimmed = String(text).trim().replace(/^(['"`])(.*)\1$/s, '$2')
  return trimmed === '' ? undefined : trimmed
}

/** Compare two sets by name and report both directions of a mismatch. */
function same(label, actual, expected) {
  const names = actual.map(entry => (typeof entry === 'string' ? entry : entry.field))
  const missing = expected.filter(name => !names.includes(name))
  const extra = names.filter(name => !expected.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label}: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`)
  }
}

/**
 * Hold every documented default to the one the code ships.
 *
 * Only `Config` is authoritative: `SectionSchema`, the card, and the tables must
 * agree with it, and a place that states no default (a transport key the channel
 * resolves itself) is left alone rather than guessed at.
 * @param config - the authoritative field list.
 * @param sources - named lists whose defaults must match `Config`'s.
 */
function sameDefaults(config, sources) {
  const declared = new Map(config.map(entry => [entry.field, entry.default]))
  for (const [label, entries] of sources) {
    for (const entry of entries) {
      if (entry.default === undefined || !declared.has(entry.field)) continue
      const expected = declared.get(entry.field)
      if (expected === undefined) {
        fail(`${label}: '${entry.field}' claims default '${entry.default}' but Config declares none`)
      } else if (entry.default !== expected) {
        fail(`${label}: '${entry.field}' defaults to '${entry.default}', but the code ships '${expected}'`)
      }
    }
  }
}

const config = schemaFields(read('index.js'), 'export const Config = z.object({')
const section = schemaFields(read('index.js'), 'const SectionSchema = z.object({')
const card = clientFields(read('client.js'))
const english = read('docs/configuration.md')
const chinese = read('docs/zh-CN/configuration.md')

if (config.length === 0) fail('Config: found no fields (did the schema change shape?)')
if (section.length === 0) fail('SectionSchema: found no fields')
if (card.length === 0) fail('client FIELDS: found no fields')

const configNames = config.map(entry => entry.field)
const sectionNames = section.map(entry => entry.field)
const cardNames = card.map(entry => entry.field)

// The section is the user-tunable subset; the card edits exactly that subset and
// nothing more, so a field the card can write is a field the section must carry.
same('SectionSchema vs Config', sectionNames, configNames.filter(name => sectionNames.includes(name)))
same('client FIELDS vs SectionSchema', cardNames, sectionNames)

/**
 * The set of fields the Host will serve as editable, held to the card.
 *
 * `liveField` writes the marker the Host's form projection is keyed on, and
 * `index.js` turns the Host's own generated page off with
 * `configure({ auto: false })`. Together those two mean the marked set *is* the
 * settings surface: a field marked and absent from the card is editable on no
 * surface at all, and a card field left unmarked is a control the Host never sends.
 * Neither shows up as a failure anywhere — the first is a setting nobody can
 * change, the second an empty control — so both are refused here.
 *
 * The failure already happened once in the other direction: a `liveField` that
 * asked for a helper the profile's library did not have wrote no marker at all, the
 * Host built no form for the entry, and the page was blank while this gate passed
 * (#89). This is the gate that would have caught it.
 */
const marked = config.filter(entry => entry.volatile).map(entry => entry.field)
same('Config fields carrying the volatile marker vs client FIELDS', marked, cardNames)
if (marked.length === 0) {
  fail('Config: no field carries the volatile marker, so the Host serves no form at all')
}

/**
 * A required field with no default is a form that never becomes ready.
 *
 * `plainSchema` keeps `meta.required` on every non-secret node
 * (`dsh-settings/lib/index.js:103-117`), and the Host describes an entry when at
 * least one field is marked. A marked required field with no value resolves to
 * nothing, the browser's rehydration of the schema and the projected value fails
 * validation, and the form sits at "loading" for good — served, visible and
 * unusable, which reads to a person as a broken plugin rather than as a missing
 * setting. So every field this plugin declares keeps a default.
 */
for (const entry of config) {
  if (entry.required && entry.default === undefined) {
    fail(`Config: '${entry.field}' is required with no default, so the settings form would never become ready`)
  }
}

/** The two config tables: the English reference page, and its Chinese counterpart. */
const tables = [
  ['docs/configuration.md table', readmeTable(english, 'docs/configuration.md', '| Field | Default | Meaning |')],
  ['docs/zh-CN/configuration.md table', readmeTable(chinese, 'docs/zh-CN/configuration.md', '| 字段 | 默认 | 说明 |')],
]

for (const [label, rows] of tables) {
  // The table is the only place a reader learns what exists, so it must name
  // every key the plugin accepts — a missing row is an invisible setting.
  for (const name of configNames) {
    if (!rows.some(row => row.field === name)) fail(`${label}: no row for Config key '${name}'`)
  }
  for (const row of rows) {
    if (!configNames.includes(row.field)) fail(`${label}: row '${row.field}' is not a Config key`)
  }
}

/** Each README's example, and the bundle patch's. */
const reference = read('docs/configuration.md')
const englishExample = readmeExample(reference, 'docs/configuration.md')
const chineseExample = readmeExample(chinese, 'docs/zh-CN/configuration.md')
const patch = patchExampleFields(read('cordis.patch.yml'))

for (const [label, entries] of [['docs/configuration.md example', englishExample], ['docs/zh-CN/configuration.md example', chineseExample]]) {
  for (const entry of entries) {
    // `channelConfig` is the channel's own object, not a Config key; `config:`
    // is the row's own key in the layer, not a setting.
    if (entry.field === 'channelConfig' || entry.field === 'config') continue
    if (!configNames.includes(entry.field)) {
      fail(`${label}: '${entry.field}' is not a Config key (a removed setting left behind?)`)
    }
  }
}
// The example names deployment keys (`channel`, `channelConfig`) beside the
// user-tunable ones, so it must stay inside Config while still showing every
// key the Settings card can write.
for (const entry of patch) {
  if (!configNames.includes(entry.field)) {
    fail(`cordis.patch.yml example: '${entry.field}' is not a Config key`)
  }
}
for (const name of sectionNames) {
  if (!patch.some(entry => entry.field === name)) {
    fail(`cordis.patch.yml example: does not show '${name}'`)
  }
}

// The examples are what a deployment copies, so they must read as a valid layer:
// every user-tunable key present, and at the value the code already ships.
sameDefaults(config, [
  ['cordis.patch.yml example', patch],
  ['docs/configuration.md example', englishExample],
  ['docs/zh-CN/configuration.md example', chineseExample],
  ['docs/configuration.md table', tables[0][1]],
  ['docs/zh-CN/configuration.md table', tables[1][1]],
])

/**
 * Hold the published documents to the published file list.
 *
 * A README reaches npm with its relative links intact, so a doc that points at a
 * file `package.json`'s `files` does not carry becomes a 404 for every reader on the
 * registry — the same failure as a table naming a key the plugin does not accept.
 * @param manifest - the parsed `package.json`.
 * @param root - the repository root, for reading each document.
 */
function checkPublishedLinks(manifest, root) {
  /** A path is published when an entry names it, or covers it as a directory. */
  const isPublished = (rel) => manifest.files.some(entry => entry.endsWith('/')
    ? rel === entry.slice(0, -1) || rel.startsWith(entry)
    : entry === rel)

  // Every document in the repository is read; only the published ones are held to the
  // package's file list. A published document that links to an unpublished file is the
  // 404 case above. An internal document may cite anything, including a decision
  // record that ships — what it must not do is become the reason a published file
  // exists, which is why it lives outside `docs/` and is never in `files`.
  const documents = ['README.md', 'README.en.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md']
  // The channel contract is published as well, and it is the one published document outside
  // `docs/`: a link from it to something the tarball does not carry 404s on the registry
  // exactly the way a README's does.
  documents.push('providers/README.md')
  const walk = (dir) => {
    if (!existsSync(resolve(root, dir))) return
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith('.md')) documents.push(next)
    }
  }
  walk('docs')

  for (const document of new Set(documents)) {
    if (!existsSync(resolve(root, document))) continue
    const source = readFileSync(resolve(root, document), 'utf8')
    for (const match of source.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
      const target = match[1].split('#')[0]
      if (target === '') continue
      const resolved = resolve(root, dirname(document), target)
      const rel = relative(root, resolved).split('\\').join('/')
      // A link may name a directory rather than a file — `docs/` is how a reader reaches
      // the index inside it. What has to ship is something the reader lands on, so the
      // directory itself is published when its `README.md` is; a directory with no index
      // would render as a file listing on GitHub and a 404 on npm.
      const wanted = existsSync(resolved) && statSync(resolved).isDirectory() ? `${rel}/README.md` : rel
      if (!isPublished(wanted)) {
        fail(`${document}: links to ${target}, which package.json's files does not publish`)
      }
    }
  }
}

checkPublishedLinks(JSON.parse(read('package.json')), root)

/**
 * A README's visuals must render on both surfaces it is read on.
 *
 * Two rules, because the two failures are different:
 *
 * 1. **Every image reference in a root README is absolute.** The README is rendered on
 *    GitHub *and* re-hosted on npmjs.com, and `assets/` is deliberately not in
 *    `package.json`'s `files` — a 4 MB package does not need 3 MB of GIF. npm re-hosts
 *    only what the tarball carries, so a relative `assets/…` path renders on GitHub and
 *    404s on the package page. An absolute `raw.githubusercontent.com` url lands on
 *    both, which is why this is enforced rather than left to whoever adds the image.
 * 2. **A reference a reader would load has to resolve locally.** The commented insertion
 *    point is a plan, not an image (rule 1 applies to it too, so it stays correct the
 *    day it is uncommented), but a live relative reference must exist.
 *
 * @param root - the repository root.
 */
function checkReadmeVisuals(root) {
  for (const document of ['README.md', 'README.en.md']) {
    const source = readFileSync(resolve(root, document), 'utf8')
    for (const match of source.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) {
      const target = match[1]
      if (!/^https?:\/\//.test(target)) {
        fail(`${document}: renders ${target} by a relative path, which 404s on npmjs.com — use an absolute url`)
        continue
      }
      // Only a local reference can be resolved here; the npm rule above is the point.
    }
    // A reference inside an HTML comment is a plan, but a plan still has to be correct.
    const live = source.replace(/<!--[\s\S]*?-->/g, '')
    for (const match of live.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) {
      const target = match[1]
      if (/^https?:\/\//.test(target)) continue
      if (!existsSync(resolve(root, target))) {
        fail(`${document}: renders ${target}, which does not exist`)
      }
    }
  }
}

checkReadmeVisuals(root)

/**
 * A published document that quotes a byte budget must quote the code's own number.
 *
 * This exists because the failure already happened once, in the other direction: the README said
 * the platform capped a card at 30 KB and that text was held under 4.5 KB, while the code shipped a
 * 32 KB budget and the platform was measured accepting 131 KB. The README is the only document a
 * reader outside this repository sees, so a number in it that disagrees with `budget.js` is not a
 * stale comment — it is the published claim being wrong, and it took a measurement against the real
 * tenant to find it because nothing compared the two.
 *
 * Only the constant is pinned, not the measurements: a measured figure is evidence and may be
 * legitimately exceeded by the next measurement, while a quoted budget is a fact about this code.
 * The derived readings (characters, the size of an example plan) are deliberately left free — they
 * are consequences of the constant, and pinning them would make an honest re-measurement fail.
 *
 * @param root - the repository root.
 */
function checkDocumentedBudgets(root) {
  const source = read('budget.js')
  const readConstant = (name) => {
    const match = new RegExp(`export const ${name} = (\\d+)(?: \\* (\\d+))?`).exec(source)
    if (match === null) throw new Error(`check-parity: budget.js exports no ${name}`)
    return match[2] === undefined ? Number(match[1]) : Number(match[1]) * Number(match[2])
  }
  const bytes = readConstant('CARD_TEXT_BUDGET')
  const kb = bytes / 1024
  if (!Number.isInteger(kb)) fail(`check-parity: CARD_TEXT_BUDGET is ${bytes} bytes, which is not a whole KB`)

  // The same sentence appears in both READMEs, so both are checked: they are written independently
  // and one of them drifting is exactly how the two languages start telling different stories.
  for (const document of ['README.md', 'README.en.md']) {
    const text = readFileSync(resolve(root, document), 'utf8')
    const stated = new RegExp(`held under \\*\\*${kb} KB|限制在 \\*\\*${kb} KB`)
    if (!stated.test(text)) {
      fail(`${document}: does not state the card's text budget as ${kb} KB, which is what budget.js ships`)
    }
    if (/\b4\.5 KB|4\.5 KB/.test(text)) {
      fail(`${document}: still quotes the retired 4.5 KB budget, which contradicted the code`)
    }
  }
}

checkDocumentedBudgets(root)

if (problems.length > 0) {
  console.error('check-parity: the places that must agree do not')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`check-parity: ${config.length} config fields agree across Config, SectionSchema, the card, both config pages, and the bundle patch — names and defaults; the ${marked.length} fields carrying the volatile marker are exactly the card's, so the Host's form and the card cannot disagree about what is editable; every published document links only to published files; and a quoted card-text budget matches budget.js`)
