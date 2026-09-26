/**
 * What the running Host requires of this plugin's `Config`, as executable code.
 *
 * The suite stands in for seven production dependencies (see
 * `tests/fixtures/stubs-loader.mjs`), so a stand-in that is subtly unlike the real
 * library can make a broken plugin pass every case in this repository. It has
 * happened: the schemastery stand-in modelled volatility as a private
 * `isVolatile` flag while the Host reads `schema.meta.volatile`, so a `liveField`
 * that asked for a helper the profile's library did not have landed every field
 * unmarked, the Host built no form for the entry, and the settings page was
 * blank — with 277 green tests and a green release.
 *
 * The answer is to stop describing the Host in prose and encode it once, here, by
 * transcribing the code that decides. Every function below names the file and line
 * it was read from, in the Host this plugin was verified against
 * (`@deepseek-ai/dsh` 0.1.7-rc.2). A case asserts against these functions rather
 * than against the stand-in, so the stand-in can only be wrong in a way that fails
 * a test.
 *
 * Three rules follow, and the rest of the suite is expected to keep them:
 *
 * 1. Volatility is `meta.volatile` — a marker on the schema, not a property the
 *    library exposes. `volatile()` is only the helper that writes it.
 * 2. The user-visible exit is `formOf(Config)` returning a form. A case about the
 *    settings surface asserts on that, not on the marker alone.
 * 3. A field the marker does not reach is a field no surface can edit, because the
 *    plugin turns the Host's generated page off (`index.js`, `configure({ auto: false })`).
 *
 * @module tests/support/host-contract
 */

/** Version suffix that tells the two shapes of a resolved schema library apart. */
const HELPERS = 'volatile'
const WRITER = 'extra'

/**
 * Whether a schema can be a form at all.
 *
 * From `@deepseek-ai/dsh-settings` 0.1.7-rc.2 `lib/index.js:538-541` — the Host
 * resolves an entry's schema out of the fiber's runtime `Config` and refuses
 * anything that is not a schemastery schema:
 *
 *     schema(entry) {
 *       const schema = entry.fiber?.runtime?.Config
 *       return schema !== void 0 && 'toJSON' in schema ? schema : void 0
 *     }
 *
 * It reads `toJSON`, so a plain object or a JSON-Schema literal is silently no
 * form at all.
 * @param schema - the schema a Host would read off a running entry.
 * @returns whether the Host would treat it as a schema.
 */
export function isSchema(schema) {
  return schema !== undefined && schema !== null && 'toJSON' in Object(schema)
}

/**
 * Whether the entry is one the Host can serve a form for.
 *
 * From `lib/index.js:413-419` — the entry has to be **active** with a runtime, and
 * a draft settings entry (an unmet `inject`, say) is skipped rather than listed:
 *
 *     if (schema === void 0 || entry.fiber === void 0
 *       || entry.fiber.runtime === null || entry.fiber.state !== 2) return []
 *
 * `state === 2` is Cordis's ACTIVE. A form for an inactive entry is not a form a
 * user can see.
 * @param entry - `{ schema, state, runtime }` as the Loader holds it.
 * @returns whether the Host would consider the entry.
 */
export function isServed(entry) {
  if (!isSchema(entry?.schema)) return false
  if (entry.state !== 2) return false
  return entry.runtime !== null && entry.runtime !== undefined
}

/**
 * The subtree of a schema the Host exposes as editable.
 *
 * From `lib/index.js:118-131`, transcribed whole because the shape of this
 * function *is* the contract:
 *
 *     function volatileForm(schema) {
 *       if (schema.meta.volatile) return plainSchema(schema)
 *       if (schema.type === 'object') {
 *         const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
 *           const field = volatileForm(child)
 *           return field === void 0 ? [] : [[key, field]]
 *         }))
 *         return Object.keys(dict).length === 0 ? void 0 : z.object(dict)
 *       }
 *     }
 *
 * Two consequences a plugin has to live with, and the reason this is transcribed
 * rather than summarised:
 *
 * - A field is editable when the marker sits on it **or above it**. An ancestor's
 *   marker carries its whole subtree.
 * - Only `type === 'object'` is descended. A root that is a union, a dict, an
 *   array or a scalar yields a form only if that root carries the marker itself.
 * @param schema - one schema node.
 * @returns the form's schema, or undefined when nothing under it is marked.
 */
export function volatileForm(schema) {
  if (schema?.meta?.volatile) return schema
  if (schema?.type !== 'object') return undefined
  const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
    const field = volatileForm(child)
    return field === undefined ? [] : [[key, field]]
  }))
  return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
}

/**
 * The names of the fields a form would offer, in declaration order.
 *
 * The Host ships the form to the browser as `form.toJSON()` (`lib/index.js:444`)
 * and the browser builds one control per leaf it can render, so this is the list a
 * reader sees. A leaf is named by the key it sits under — the kind it carries is a
 * type, not a name — and a nested object contributes its children's paths.
 * `plainSchema` (`lib/index.js:103-117`) keeps `meta.required` on every non-secret
 * node, which is what makes a required field with no value a form that never
 * becomes ready rather than a field that renders empty.
 * @param form - a form schema, as {@link volatileForm} returns.
 * @returns one name per leaf, in order.
 */
export function fieldNames(form) {
  if (form === undefined || form === null) return []
  if (form.dict === undefined) return []
  return Object.entries(form.dict).flatMap(([key, child]) => {
    const inner = fieldNames(child)
    return inner.length === 0 ? [key] : inner.map(name => `${key}.${name}`)
  })
}

/**
 * What a reader of the Plugins page would actually find.
 *
 * This is the exit every case about the settings surface should assert on: not
 * "the marker was written" but "a form exists, and these are its fields". The
 * distinction is the whole of issue #89 — the marker is the mechanism, the form is
 * the thing a person sees.
 * @param schema - the plugin's `Config`.
 * @param options - `active` (default true) models an entry the Host will serve.
 * @returns `{ served, fields }`, with `fields` empty when nothing is served.
 */
export function formOf(schema, { active = true } = {}) {
  const entry = { schema, state: active ? 2 : 1, runtime: { Config: schema } }
  if (!isServed(entry)) return { served: false, fields: [] }
  const form = volatileForm(schema)
  if (form === undefined) return { served: false, fields: [] }
  return { served: true, fields: fieldNames(form) }
}

/**
 * Whether a resolved value is the live reference the Host hands a volatile field.
 *
 * The Host wraps a marked field's resolved value at
 * `@deepseek-ai/schemastery` `lib/index.mjs:265-277` (`createVolatile(value)` from
 * `Schema.resolve`), and the Loader updates that reference *in place* when the form
 * writes (`@deepseek-ai/cordis-plugin-loader` `lib/index.js:410-415`,
 * `updateVolatile`). So the plugin's half of the contract is to read it at use with
 * `get()`, never to capture the snapshot at load.
 *
 * The real reference is a frozen object whose write half is a `Symbol.for`-keyed
 * method (`@deepseek-ai/cosmokit` `lib/index.js:102-118`); `isVolatile` there is a
 * *function*, not a flag, which is worth knowing because a stand-in that models it
 * as a boolean is exactly the class of drift this module exists to prevent.
 * @param value - one resolved `Config` field.
 * @returns whether it is a live reference.
 */
export function isLiveReference(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

/**
 * The helper names a resolved schema library has to be asked for by capability.
 *
 * `volatile()` writes the marker; `extra(key, value)` is the older call the same
 * helper is made of (`@deepseek-ai/schemastery` `lib/index.mjs:128-135`,
 * `:235-238`). A library older than the Host's own has `extra` and no `volatile`,
 * which is a legitimate resolution because this plugin's peer range is `*` — and
 * the Host never checks it, because the compatibility gate skips every peer that is
 * not `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
 * (`@deepseek-ai/dsh-app-boot` `lib/index.js:292-301`).
 */
export const LIBRARY_CALLS = { writer: WRITER, helper: HELPERS }

/**
 * Which of the two calls a schema library answers — the version axis a case walks.
 *
 * A library that predates `volatile()` is not hypothetical: the reporter's profile
 * resolved schemastery 3.18.1 beside a 0.1.7 Host that carried 3.18.4. So a case
 * that only ever exercises the newer shape has not tested the support window at
 * all.
 * @param library - the default export of a schema library stand-in.
 * @returns `{ helper, writer }`, one boolean per call.
 */
export function libraryShape(library) {
  const field = typeof library?.string === 'function' ? library.string() : undefined
  const proto = field === undefined ? undefined : Object.getPrototypeOf(field)
  return {
    helper: typeof proto?.[HELPERS] === 'function',
    writer: typeof proto?.[WRITER] === 'function',
  }
}
