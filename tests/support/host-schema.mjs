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
function markedNames(node, blocked = false) {
  if (node === undefined || node === null) return []
  if (node.meta?.volatile) {
    if (blocked) return []
    if (node.dict === undefined) return undefined
    // The subtree is what this node contributes, so its own leaves are named even
    // though they sit under a marker: `blocked` is about a marker *inside* another
    // marked node's walk, not about the walk the marker itself starts.
    return Object.entries(node.dict).flatMap(([key, child]) => {
      const inner = markedNames(child, false)
      if (inner === undefined) return [key]
      return inner.length === 0 ? [] : inner.map(name => `${key}.${name}`)
    })
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
    const envelope = typeof result === 'object' && 'value' in result && 'issues' in result
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
export function inspectSchema(schema, sample = undefined) {
  const fields = markedFields(schema)
  const attempts = resolutionsOf(schema, sample)
  const shapes = attempts.map(attempt => attempt.shape)
  let live = false
  for (const attempt of attempts) {
    if (attempt.value === undefined) continue
    const marked = fields.find(name => name.split('.')[0] === 'delaySeconds')
    const candidate = attempt.value.delaySeconds
      ?? (marked === undefined ? undefined : attempt.value[marked.split('.')[0]])
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.get === 'function') {
      live = true
      break
    }
  }
  return { fields, live, shapes }
}
