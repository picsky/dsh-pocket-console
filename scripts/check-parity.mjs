/**
 * Field-parity gate.
 *
 * One user-tunable setting lives in five places: the plugin `Config`, the
 * `SectionSchema` the Settings card is built from, the card's own `FIELDS`, the
 * README tables, and the example in `cordis.patch.yml`. Adding one and missing
 * another fails silently at runtime, so this gate reads each place and refuses
 * to pass unless they agree.
 *
 * Text is parsed rather than imported on purpose: the gate must not depend on
 * the plugin loading, and a source whose fields it cannot find fails loudly
 * instead of comparing two empty sets.
 *
 * Run: npm run check:parity
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')

/** Every `name: z.…` key inside one `z.object({ … })` block. */
function schemaFields(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`check-parity: ${marker} not found`)
  const end = source.indexOf('\n})', start)
  if (end === -1) throw new Error(`check-parity: ${marker} has no closing brace`)
  const block = source.slice(start, end)
  return [...block.matchAll(/^ {2}([A-Za-z][\w]*): z\./gm)].map(match => match[1])
}

/** The plugin's own table rows: the first table under the given header. */
function tableFields(source, label, header) {
  const at = source.indexOf(header)
  if (at === -1) throw new Error(`check-parity: ${label} has no config table (${header})`)
  const rows = []
  for (const line of source.slice(at).split('\n').slice(2)) {
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line)
    if (row === null) break
    rows.push(row[1])
  }
  return rows
}

/** The config keys the commented example in the bundle patch shows, at `config:` depth. */
function patchExampleFields(source) {
  const keys = [...source.matchAll(/^# {7}([a-z][\w]*):/gm)].map(match => match[1])
  if (keys.length === 0) throw new Error('check-parity: cordis.patch.yml shows no example keys')
  return keys
}

const config = schemaFields(read('index.js'), 'export const Config = z.object({')
const section = schemaFields(read('index.js'), 'const SectionSchema = z.object({')
const card = (() => {
  const source = read('client.js')
  const start = source.indexOf('const FIELDS = [')
  if (start === -1) throw new Error('check-parity: client.js has no FIELDS list')
  // The list closes at the statement's own indentation; a nested `options: [`
  // closes earlier, so the first `]` is not the end of the array.
  const end = source.indexOf('\n    ]', start)
  if (end === -1) throw new Error('check-parity: client.js FIELDS list has no end')
  return [...source.slice(start, end).matchAll(/field: '([^']+)'/g)].map(match => match[1])
})()

const problems = []
const same = (label, actual, expected) => {
  const missing = expected.filter(name => !actual.includes(name))
  const extra = actual.filter(name => !expected.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    problems.push(`${label}: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`)
  }
}

if (config.length === 0) problems.push('Config: found no fields (did the schema change shape?)')
if (section.length === 0) problems.push('SectionSchema: found no fields')
if (card.length === 0) problems.push('client FIELDS: found no fields')

same('SectionSchema vs Config', section, config.filter(name => section.includes(name)))
same('client FIELDS vs SectionSchema', card, section)
same('README.md table vs Config', tableFields(read('README.md'), 'README.md', '| Field | Default | Meaning |'), config)
same(
  'README.zh-CN.md table vs Config',
  tableFields(read('README.zh-CN.md'), 'README.zh-CN.md', '| 字段 | 默认 | 说明 |'),
  config,
)

const example = patchExampleFields(read('cordis.patch.yml'))
// The example names deployment keys (channel, channelConfig) beside the
// user-tunable ones, so it must stay inside Config while still showing every
// key the Settings card can write.
const strayExample = example.filter(name => !config.includes(name))
if (strayExample.length > 0) problems.push(`cordis.patch.yml example: not config fields [${strayExample.join(', ')}]`)
const unshown = section.filter(name => !example.includes(name))
if (unshown.length > 0) problems.push(`cordis.patch.yml example: does not show [${unshown.join(', ')}]`)

if (problems.length > 0) {
  console.error('check-parity: the same settings disagree between places')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`check-parity: ${config.length} config fields agree across Config, SectionSchema, the card, both READMEs, and the bundle patch`)
