/**
 * The Host's own settings gate, read out of a resolved schema library.
 *
 * `@deepseek-ai/dsh-settings` decides whether an entry has a form by walking the
 * entry's `Config` for `meta.volatile` (`lib/index.js:118-131`), and the value a marked
 * field resolves to is a live reference the form writes through
 * (`@deepseek-ai/schemastery`, `createVolatile`). Neither is a documented API a plugin
 * may call — this module exists so that a build step can ask the same two questions
 * **of the library the deployment resolved**, in the profile it is installed in, which
 * is the only place the failure of #89 is visible: a profile resolved a schemastery
 * older than its Host's, the plugin asked for a helper that copy did not have, no
 * marker was written, and the settings page was blank while every stand-in-based case
 * passed.
 *
 * So nothing here assumes a version. Both calls are made by capability, and every
 * capability that is missing is named rather than guessed at:
 *
 * - The marker is `meta.volatile` on the node, or on an ancestor of it, which is the
 *   walk the Host performs. A marked leaf is named by the key it sits under.
 * - The value is read through whichever resolution call the library publishes. The
 *   shapes have moved across the versions this plugin supports — `~standard.validate`,
 *   `validate`, `Schema.resolve`, and the callable-with-`.resolve` form — so each is
 *   tried and the one that answers is reported.
 *
 * @module tests/support/host-schema
 */

/**
 * The names a marked node contributes, or undefined when the node is itself a marked
 * leaf the caller has to name.
 *
 * A sentinel rather than an empty list, because an empty list is also what "nothing
 * marked below this" looks like — and conflating the two is what dropped every marked
 * leaf the first time this walk was written.
 * @param node - one schema node.
 * @param blocked - whether an ancestor already carries the marker.
 * @returns the names below this node, or undefined when the node is a marked leaf.
 */
/**
 * The leaf paths under one node, relative to it.
 *
 * `''` stands for the node itself being a leaf, so a caller prefixes the key it sits
 * under without a second special case. Markers are deliberately ignored: a marker above
 * has already claimed this whole subtree, and the Host does not serve a marked leaf twice.
 * @param node - one schema node.
 * @returns the paths, deepest key last.
 */
function leavesOf(node) {
  if (node === undefined || node === null) return []
  if (node.dict !== undefined && typeof node.dict === 'object') {
    return Object.entries(node.dict).flatMap(([key, child]) => leavesOf(child).map(name => `${key}${name === '' ? '' : `.${name}`}`))
  }
  return ['']
}

function markedNames(node, blocked = false) {
  if (node === undefined || node === null) return []
  if (node.meta?.volatile) {
    if (blocked) return []
    if (node.dict === undefined) return undefined
    // The marker carries the whole subtree, so what this node contributes is **every leaf
    // under it** — not only the leaves that carry a marker of their own. `volatileForm`
    // projects `["group.x"]` for a marked container whose leaf is unmarked; naming
    // nothing there was this walk's own invention, and a case here used to pin it.
    return Object.entries(node.dict).flatMap(([key, child]) => leavesOf(child).map(name => `${key}${name === '' ? '' : `.${name}`}`))
  }
  if (blocked || node.type !== 'object' || node.dict === undefined) return []
  return Object.entries(node.dict).flatMap(([key, child]) => {
    const inner = markedNames(child, false)
    if (inner === undefined) return [key]
    return inner.length === 0 ? [] : inner.map(name => `${key}.${name}`)
  })
}

/**
 * The leaf names a marked field reaches, in declaration order.
 *
 * The walk `dsh-settings` runs (`lib/index.js:118-131`): a marker on a node carries its
 * whole subtree, only objects are descended, and a marker below a marked ancestor is
 * not reached.
 * @param node - the schema root.
 * @returns the marked leaf names, or an empty list when nothing is marked.
 */
export function markedFields(node) {
  const names = markedNames(node)
  return names === undefined ? [] : names
}

/**
 * Every resolution call this plugin's support window has published.
 *
 * Ordered newest first, and each entry names the shape it is: the standard-schema
 * interface 0.1.7's schemastery uses, the plain `validate` on the schema itself, the
 * static `Schema.resolve` a library may expose as a named export, and the callable
 * schema with a `resolve` of its own. A library that answers none of them is reported
 * as such rather than as "no form", because the two are different facts.
 * @param schema - the schema to resolve.
 * @param value - the raw config to resolve against.
 * @returns one entry per call that produced a value.
 */
export function resolutionsOf(schema, value) {
  const attempts = [
    ['~standard.validate', () => schema?.['~standard']?.validate?.(value)],
    ['validate', () => schema?.validate?.(value)],
    ['Schema.resolve', () => schema?.resolve?.(value)],
    ['call .resolve', () => (typeof schema === 'function' ? schema.resolve(value) : undefined)],
    ['call', () => (typeof schema === 'function' ? schema(value) : undefined)],
  ]
  const found = []
  for (const [shape, attempt] of attempts) {
    let result
    try {
      result = attempt()
    } catch (error) {
      found.push({ shape, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (result === undefined || result === null) continue
    // The standard interface wraps its value — `{ value, issues }` — and the others
    // answer with the value itself. The wrapper is recognised by the pair, not by the
    // presence of `value`: a resolved config may legitimately have a field called
    // `value`, and unwrapping that would hand the caller a field instead of a config.
    // The standard interface wraps its answer — `{ value, issues }`, or `{ issues }` alone
    // when it refuses. Recognised by `issues` being a list, which is what separates a
    // wrapper from a resolved config that happens to have a field called `value`.
    const envelope = typeof result === 'object' && Array.isArray(result.issues)
    // The standard interface answers with `issues` instead of a value when it refuses the
    // sample. That is a fact about the *call*, not a missing capability, and skipping it
    // made a probe that asked with a partial sample look exactly like a library that does
    // not publish the call at all.
    if (envelope && Array.isArray(result.issues) && result.issues.length > 0) {
      found.push({ shape, refused: result.issues.length })
      continue
    }
    const resolved = envelope ? result.value : result
    if (resolved === undefined || resolved === null || typeof resolved !== 'object') continue
    found.push({ shape, value: resolved })
  }
  return found
}

/**
 * What a reader of the Plugins page would find, and what the calls that were tried
 * answered.
 *
 * @param schema - the plugin's `Config`, built by the resolved library.
 * @param sample - a config to resolve, or undefined to resolve the defaults.
 * @returns `{ fields, live, shapes }`: the marked field names, whether a marked field
 *   resolved to a live reference on some call shape, and which shapes answered.
 */
/**
 * What one resolved value looks like, for a report.
 *
 * A probe that cannot be run against every version it will meet has to say what it
 * found rather than only whether it was happy: "the marked field is a number" and "the
 * field is missing" are different facts about a Host, and a bare boolean hides which one
 * a run met.
 * @param value - one field of a resolved config.
 * @returns a short description of its shape.
 */
function describeValue(value) {
  if (value === undefined) return 'absent'
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  if (Array.isArray(value)) return `array(${value.length})`
  const keys = Object.keys(value).slice(0, 4).join(',')
  return typeof value.get === 'function' ? 'live reference' : `object{${keys}}`
}

/**
 * What a reader of the Plugins page would find, and what the calls that were tried
 * answered.
 *
 * Two facts, and they are deliberately separate:
 *
 * - **`fields`** — the marked leaves the Host would serve a form for. This is the gate
 *   `volatileForm` applies, and it is what a form's existence depends on, so it is what
 *   a build fails on.
 * - **`values`** — how the resolved value of each marked field looked, per call shape.
 *   A marked field is supposed to resolve to a live reference the form writes through,
 *   and reporting what it actually resolved to is how a version this probe cannot be
 *   run against locally stays diagnosable.
 *
 * @param schema - the plugin's `Config`, built by the resolved library.
 * @param sample - a config to resolve, or undefined to resolve the defaults.
 * @returns `{ fields, live, shapes, values }`.
 */
export function inspectSchema(schema, sample = undefined) {
  const fields = markedFields(schema)
  const attempts = resolutionsOf(schema, sample)
  const shapes = attempts.map(attempt => attempt.shape)
  const values = {}
  let live = false
  for (const attempt of attempts) {
    if (attempt.refused !== undefined) {
      values[attempt.shape] = `refused (${attempt.refused} issues)`
      continue
    }
    if (attempt.value === undefined) {
      values[attempt.shape] = 'no value'
      continue
    }
    const candidate = attempt.value.delaySeconds
    values[attempt.shape] = describeValue(candidate)
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.get === 'function') {
      live = true
    }
  }
  return { fields, live, shapes, values }
}
