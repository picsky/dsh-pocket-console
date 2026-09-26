/**
 * Does the Host in an installed profile actually serve a settings form for this
 * plugin?
 *
 * `scripts/e2e-profile.mjs` proves the artifact activates and that the page boots the
 * right bundle. Neither says a person can see the settings, because the form exists
 * only if the marker the Host's projection is keyed on reached the **Host's own copy**
 * of the schema library. That is the whole of #89: a profile resolved a schemastery
 * older than the Host's, the plugin asked for a helper that copy did not have, no
 * marker was written, and the Plugins page listed the plugin with nothing to edit
 * while every other check — here and in the unit suite — stayed green.
 *
 * So this asks the question where the answer actually lives: inside the profile. It
 * imports the schema library that deployment resolved, evaluates the plugin's
 * **shipped** `liveField` and `Config` against it, and reports the fields the Host
 * would offer.
 *
 * Two deliberate choices, both about fidelity:
 *
 * - The library comes from the profile, not from this repository. A stand-in is
 *   exactly what could not see this failure, and the version axis here is
 *   `volatile()` versus `extra()` — a library older than the Host's is a legitimate
 *   resolution, so the marker has to be written through whichever of the two exists.
 * - `Config` and `liveField` are read out of the shipped source rather than imported
 *   through the module graph, because `index.js` statically imports Host services
 *   that only exist inside a running application. Nothing the probe does depends on
 *   them: this is about the schema the tarball declares, not about activation, which
 *   the boot in `e2e-profile.mjs` already proves.
 *
 * Run: node scripts/probe-installed-form.mjs <plugin-dir> [<search-from>]
 *   plugin-dir   the copy the profile installed
 *   search-from  where to start looking for the resolved schema library, defaulting
 *                to the plugin directory
 * Prints one JSON line: `{ ok, detail, fields?, resolved? }`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join, parse } from 'node:path'
import { inspectSchema } from '../tests/support/host-schema.mjs'

/** The fields the settings card edits, in declaration order. */
const EXPECTED = ['delaySeconds', 'titlePrefix', 'resultNotify', 'debug']

/**
 * Walk up from one path looking for a resolved package.
 *
 * This is Node's own lookup, narrowed to one package: a profile hoists its
 * dependencies into a `node_modules` beside the entry, and `@deepseek-ai/dsh` keeps
 * its own tree beside its install. Whichever the deployment resolves is the one the
 * Host would hand the plugin, so this is the axis being measured rather than an
 * implementation detail.
 * @param from - directory to start at.
 * @param specifier - package name, such as `schemastery`.
 * @returns the package directory, or undefined when nothing resolves.
 */
function findPackage(from, specifier) {
  let current = from
  for (;;) {
    const candidate = join(current, 'node_modules', '@deepseek-ai', specifier)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(current)
    if (parent === current || current === parse(current).root) return undefined
    current = parent
  }
}

/**
 * The `@deepseek-ai/schemastery` the deployment resolved, from wherever it resolved
 * it.
 *
 * Two roots, because a profile need not carry the library at all: `pnpm-workspace.yml`
 * sets `autoInstallPeers: false`, so a peer may be satisfied by whatever the profile
 * hoisted or by nothing, and the copy beside `@deepseek-ai/dsh` is the one an entry
 * then resolves from the application tree. The directory a caller names first is the
 * narrower one, so a profile that did hoist a copy gets that copy measured.
 * @param roots - directories to search from, in order.
 * @returns the package directory, or undefined.
 */
function findSchemaLibrary(roots) {
  for (const root of roots) {
    if (root === undefined) continue
    const found = findPackage(root, 'schemastery')
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The entry module of a schema library, by the shapes it publishes.
 * @param dir - the package directory.
 * @returns the file to import, or undefined.
 */
function schemaEntry(dir) {
  if (dir === undefined) return undefined
  return [
    join(dir, 'lib', 'index.mjs'),
    join(dir, 'lib', 'index.js'),
    join(dir, 'index.mjs'),
    join(dir, 'index.js'),
  ].find(candidate => existsSync(candidate))
}

/**
 * One balanced call's argument text, braces and all.
 *
 * The source is scanned rather than imported, so the extraction has to survive the
 * object literal it is reading: counting braces is what keeps `Config`'s own `}`
 * from ending the slice early.
 * @param source - the plugin's `index.js`.
 * @param marker - the prefix the argument starts after.
 * @returns the argument text, or undefined when the call is unterminated.
 */
function balancedArgument(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) return undefined
  const from = source.indexOf('(', start)
  if (from === -1) return undefined
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

/**
 * One arrow function out of the plugin source, by name, as a callable.
 *
 * The shipped declaration is read rather than restated, so what this measures is the
 * marker the tarball writes and not a copy of it. Both bodies are accepted — the
 * block form this plugin ships, and the one-expression form a simpler version had —
 * because the check is about the marker, not about how the arrow is punctuated.
 * @param source - the plugin's `index.js`.
 * @param name - the declared const.
 * @returns the callable, or undefined when the declaration cannot be read.
 */
function arrowFunction(source, name) {
  const declaration = `const ${name} = (schema) => `
  const start = source.indexOf(declaration)
  if (start === -1) return undefined
  const bodyStart = start + declaration.length
  let body
  if (source[bodyStart] === '{') {
    let depth = 0
    for (let index = bodyStart; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          body = source.slice(bodyStart, index + 1)
          break
        }
      }
    }
  } else {
    const end = source.indexOf('\n', bodyStart)
    body = `{ return ${source.slice(bodyStart, end === -1 ? source.length : end).trim()} }`
  }
  if (body === undefined) return undefined
  try {
    return new Function('schema', `${body}`)
  } catch {
    return undefined
  }
}

/**
 * One declaration out of a shipped module, by name.
 *
 * `Config` is not self-contained: `locale` is declared as `z.union(LOCALES)`, and
 * `LOCALES` lives in `messages.js`. That module is pure copy — no Host import, no
 * module-level side effect — so the list is read from it exactly as it ships rather
 * than restated here, which is what keeps this probe from drifting from the plugin.
 * @param source - the module's source text.
 * @param name - the exported const.
 * @returns the array literal's text, or undefined.
 */
function arrayLiteral(source, name) {
  const marker = `export const ${name} = [`
  const start = source.indexOf(marker)
  if (start === -1) return undefined
  const open = start + marker.length - 1
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1
    else if (source[index] === ']') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return undefined
}

/** Report one answer and stop. */
function answer(payload) {
  console.log(JSON.stringify(payload))
  process.exit(0)
}

const [pluginDir, ...searchRoots] = process.argv.slice(2)
if (pluginDir === undefined) {
  answer({ ok: false, detail: 'usage: probe-installed-form.mjs <plugin-dir> [<search-from>...]' })
}

const source = join(pluginDir, 'index.js')
if (!existsSync(source)) {
  answer({ ok: false, detail: `the installed copy has no index.js at ${source}` })
}

try {
  // The library this deployment resolved, wherever it resolved it from: the
  // directories named by the caller first, then the installed plugin's own tree.
  const roots = [...searchRoots, pluginDir]
  const libraryDir = findSchemaLibrary(roots)
  const entry = schemaEntry(libraryDir)
  if (entry === undefined) {
    answer({ ok: false, detail: `no @deepseek-ai/schemastery resolves from any of ${roots.join(', ')}` })
  }
  const library = (await import(pathToFileURL(entry).href)).default
  const field = library.string()
  const proto = Object.getPrototypeOf(field)
  const resolved = {
    entry,
    hasVolatile: typeof proto.volatile === 'function',
    hasExtra: typeof proto.extra === 'function',
  }

  const text = readFileSync(source, 'utf8')
  const liveField = arrowFunction(text, 'liveField')
  const configSource = balancedArgument(text, 'export const Config = z.object')
  // `Config` names `LOCALES` for its `locale` union; the list ships in `messages.js`,
  // which is pure copy, so it is read from there rather than restated here.
  const messagesSource = readFileSync(join(pluginDir, 'messages.js'), 'utf8')
  const localesSource = arrayLiteral(messagesSource, 'LOCALES')
  if (liveField === undefined || configSource === undefined || localesSource === undefined) {
    answer({ ok: false, detail: 'the shipped source declares no readable liveField, Config call or LOCALES list' })
  }

  /** The plugin's `Config`, built by the resolved library and the shipped marker. */
  const buildConfig = () => new Function(
    'z',
    'liveField',
    'LOCALES',
    `return z.object(${configSource})`,
  )(library, liveField, new Function(`return ${localesSource}`)())

  /**
   * Build the schema with the helper the Host has, and with only the older writer.
   *
   * The second is the shape a profile produces by hoisting an older copy, and it is
   * the shape #89 shipped broken: both have to yield the same marked set, or a
   * deployment whose lockfile decided the version differently loses its settings.
   */
  const withHelper = buildConfig()
  const helper = proto.volatile
  delete proto.volatile
  let withoutHelper
  try {
    withoutHelper = buildConfig()
  } finally {
    // The resolved library is shared with whatever else this process might import,
    // so the helper goes back exactly as it was found.
    proto.volatile = helper
  }

  const inspected = inspectSchema(withHelper, { delaySeconds: 600 })
  const fields = inspected.fields
  const older = inspectSchema(withoutHelper).fields
  if (JSON.stringify(fields) !== JSON.stringify(EXPECTED)) {
    answer({
      ok: false,
      detail: `the Host would serve [${fields.join(', ')}] and the card edits [${EXPECTED.join(', ')}]`,
      fields,
      resolved,
    })
  }
  if (JSON.stringify(older) !== JSON.stringify(fields)) {
    answer({
      ok: false,
      detail: `with volatile() absent the marker reaches [${older.join(', ')}] instead of [${fields.join(', ')}]`,
      fields: older,
      resolved,
    })
  }

  // The other half of the marker: a marked field is supposed to resolve to the live
  // reference a form writes through, or it is a setting the form shows and never
  // changes. Which call resolves it is the library's business — the shapes have moved
  // across the versions this plugin supports — so every shape it publishes is tried and
  // what each one produced is reported, field by field.
  //
  // It is reported rather than required, and the reason is worth stating: this probe
  // runs against the libraries in the support window, and the older one is not
  // installable on the machine it was written on. Failing the build on a claim about a
  // library nobody can run here would be guessing. What is required is the marker set,
  // which is the gate `volatileForm` applies and the thing #89 was about; and what is
  // reported is the resolved shape, so a Host that stops projecting live references
  // shows up in the log of the run rather than as a mystery.
  if (inspected.shapes.length === 0) {
    answer({
      ok: false,
      detail: 'the resolved schema library answers no resolution call this probe knows',
      resolved,
      values: inspected.values,
    })
  }

  answer({
    ok: true,
    detail: `served [${fields.join(', ')}] with library ${resolved.hasVolatile ? 'carrying' : 'lacking'} volatile(), resolving through ${inspected.shapes.join('/')}`
      + `; delaySeconds resolved as ${Object.entries(inspected.values).map(([shape, shapeOf]) => `${shape}=${shapeOf}`).join(', ')}`,
    fields,
    live: inspected.live,
    values: inspected.values,
    shapeBytes: JSON.stringify(withHelper.toJSON()).length,
    resolved,
  })
} catch (error) {
  answer({ ok: false, detail: `the probe threw: ${error instanceof Error ? error.message : String(error)}` })
}
