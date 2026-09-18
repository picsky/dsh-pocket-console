/**
 * Stand-in for `zod`, as far as this plugin's one schema uses it.
 *
 * The domain layer validates stored records against a zod schema, so the plugin needs a
 * real schema to declare its table. The suite only needs the shapes it declares to be
 * checked, which is what this does: enough to catch a record whose fields do not match
 * the declaration, and nothing else.
 */

/**
 * One leaf type.
 * @param kind - the JavaScript `typeof` this leaf accepts.
 * @returns the schema, with `optional` as zod spells it.
 */
function leaf(kind) {
  return {
    kind,
    optional: false,
    /** zod's spelling, which is what the plugin writes. */
    optional() { return { ...this, optional: true } },
  }
}

/**
 * One object type.
 * @param shape - field name to field schema.
 * @returns the schema.
 */
function object(shape) {
  return {
    kind: 'object',
    shape,
    optional: false,
    optional() { return { ...this, optional: true } },
  }
}

export const z = { string: () => leaf('string'), number: () => leaf('number'), object }
export default z
