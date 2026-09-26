/**
 * Minimal local stand-in for `@deepseek-ai/schemastery`, sufficient to build and
 * resolve this plugin's `Config` without the DSH toolchain. The real Loader owns
 * schema validation in production; this exists only to drive the local logic test.
 *
 * **It has to be shaped like the real library, not like the plugin's idea of it.**
 * Volatility is `meta.volatile` — the marker the Host reads (`dsh-settings`,
 * `volatileForm`) — and `volatile()` is only the helper that writes it:
 * `extra('volatile', true)`. The earlier version of this file modelled a private
 * `isVolatile` boolean, and that single divergence is how a `liveField` that never
 * wrote the marker passed 277 cases while the settings page was blank for a real
 * deployment (`tests/support/host-contract.mjs` states the contract, and
 * `docs/decisions/0031-*` records the incident).
 *
 * The library's own axes are modelled too, because the plugin's peer range is `*`:
 *
 * - `extra()` returns a **copy** with a fresh `meta` object — the real library
 *   builds a new node (`Schema(this)`) and reassigns `meta`
 *   (`schemastery/lib/index.mjs:128-135`), so a caller's schema is not mutated and
 *   the return value has to be used.
 * - `volatile()` is defined here, but a case may delete it from the prototype to
 *   model a resolved library that predates it — a profile that hoists 3.18.1
 *   beside a 0.1.7 Host. See `tests/support/host-contract.mjs`'s `libraryShape`.
 *
 * `resolve()` follows the real order: a marked field resolves to the live
 * reference, and a nested one resolves through its children
 * (`schemastery/lib/index.mjs:256-277`).
 */

/**
 * A stable reference to one live value, which is what a volatile field resolves
 * to: the Host's settings form writes into the document and the runtime updates
 * the reference in place, so a plugin reads it at use rather than at load.
 * @param value - the resolved value.
 * @returns the reference, with the stub's stand-in for that in-place update.
 */
function live(value) {
  let current = value
  return {
    get: () => current,
    // The Loader's job, not the plugin's: a case uses it to model a form write.
    set: (next) => { current = next },
  }
}

/** One node: a leaf field, or an object with a `dict` of children. */
class Field {
  constructor(kind) {
    this.kind = kind
    /**
     * The only place volatility lives — the marker the Host reads.
     *
     * Replaced, never mutated, by {@link Field.extra}: the real library's `extra`
     * gives its copy a fresh object rather than writing through to the receiver.
     */
    this.meta = {}
    this.defaultValue = undefined
    this.hasDefault = false
    this.isRequired = false
  }

  /** The kind this node reports, spelled as the real library spells it. */
  get type() {
    // `z.object` is the only composite this plugin builds; a leaf reports the
    // kinds `volatileForm` checks — everything that is not `object`.
    return this.kind === 'object' ? 'object' : this.kind
  }

  /** The children of an object node, as the Host's walk reads them. */
  get dict() {
    return this.kind === 'object' ? this.shape : undefined
  }

  /**
   * One more meta entry, on a copy — the real library's `extra`, and the call
   * `volatile()` itself makes in the library that has both.
   * @param key - the meta entry.
   * @param value - what it holds.
   * @returns the field carrying it.
   */
  extra(key, value) {
    const next = new Field(this.kind)
    next.defaultValue = this.defaultValue
    next.hasDefault = this.hasDefault
    next.isRequired = this.isRequired
    next.values = this.values
    next.shape = this.shape
    next.meta = { ...this.meta, [key]: value }
    return next
  }

  /** Mark the field as one the settings form may edit without a remount. */
  volatile() {
    return this.extra('volatile', true)
  }

  required() {
    this.isRequired = true
    return this
  }

  default(value) {
    this.defaultValue = value
    this.hasDefault = true
    return this
  }

  /**
   * The JSON shape the Host ships to the browser.
   *
   * `plainSchema` builds the form from `schema.toJSON()`
   * (`dsh-settings/lib/index.js:103-105`), so the walk only has to reach `meta`,
   * `type` and `dict` — and the marker has to survive it, because that is the bit
   * the Host reads.
   * @returns the detached node.
   */
  toJSON() {
    const node = { type: this.type, meta: { ...this.meta } }
    if (this.hasDefault) node.meta.default = this.defaultValue
    if (this.isRequired) node.meta.required = true
    if (this.kind === 'object') {
      node.dict = Object.fromEntries(
        Object.entries(this.shape).map(([key, child]) => [key, child.toJSON()]),
      )
    }
    return node
  }

  /**
   * Apply the declared default, or throw when a required field is absent.
   *
   * The marker decides the shape of the result, at the node it sits on: marked
   * resolves to a live reference, an object resolves through its children, and
   * everything else is the value itself.
   */
  resolve(input) {
    let value
    if (input === undefined) {
      if (this.hasDefault) value = this.defaultValue
      else if (this.isRequired) throw new Error('missing required config field')
      else value = undefined
    } else {
      if (this.kind === 'union' && !this.values.includes(input)) {
        throw new Error(`value ${JSON.stringify(input)} is not in the declared union`)
      }
      value = input
    }
    if (this.meta.volatile) return live(value)
    if (this.kind === 'object') {
      const out = {}
      for (const [key, field] of Object.entries(this.shape)) out[key] = field.resolve(input?.[key])
      return out
    }
    return value
  }
}

const z = {
  string: () => new Field('string'),
  natural: () => new Field('number'),
  any: () => new Field('any'),
  union: (values) => {
    const field = new Field('union')
    field.values = values
    return field
  },
  object: (shape) => {
    const field = new Field('object')
    field.shape = shape
    return field
  },
}

export default z
