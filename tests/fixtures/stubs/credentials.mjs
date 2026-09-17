/**
 * Local stand-in for `@deepseek-ai/dsh-credentials`. The real package brands
 * and validates the reference grammar; this only has to be identity so the
 * plugin's `credentialRef(...)` calls and the fake store agree on a key.
 */

/**
 * Brand a raw string as a credential reference.
 * @param value - candidate reference name.
 * @returns the same string.
 */
export function credentialRef(value) {
  return value
}

/**
 * Brand a scope and id as a credential key.
 * @param scope - owning plugin name.
 * @param id - owner-chosen id.
 * @returns the `scope/id` string.
 */
export function credentialKey(scope, id) {
  return `${scope}/${id}`
}
