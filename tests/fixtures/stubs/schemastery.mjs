/**
 * Minimal local stand-in for `@deepseek-ai/schemastery`, sufficient to build
 * and resolve this plugin's `Config` without the DSH toolchain. The real Loader
 * owns schema validation in production; this exists only to drive the local
 * logic test. `volatile()` and `extra()` are modelled together, because the marker
 * they write — and the Host's reading of it — is what the settings form is keyed on.
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

/** One leaf field with optional default. */
class Field {
  constructor(kind) {
    this.kind = kind
    this.defaultValue = undefined
    this.hasDefault = false
    this.isRequired = false
    /** What the Host reads to decide a field is editable, and to wrap its value. */
    this.meta = {}
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

  /** Apply the declared default, or throw when a required field is absent. */
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
    return this.meta.volatile ? live(value) : value
  }
}

/** Object schema built from a shape map. */
class ObjectSchema {
  constructor(shape) {
    this.shape = shape
  }

  /** Resolve every field, applying defaults for absent input. */
  resolve(input = {}) {
    const out = {}
    for (const [key, field] of Object.entries(this.shape)) {
      out[key] = field.resolve(input[key])
    }
    return out
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
  object: (shape) => new ObjectSchema(shape),
}

export default z
