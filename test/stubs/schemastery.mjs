/**
 * Minimal local stand-in for `@deepseek-ai/schemastery`, sufficient to build
 * and resolve this plugin's `Config` without the DSH toolchain. The real Loader
 * owns schema validation in production; this exists only to drive the local
 * logic test.
 */

/** One leaf field with optional default. */
class Field {
  constructor(kind) {
    this.kind = kind
    this.defaultValue = undefined
    this.hasDefault = false
    this.isRequired = false
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
    if (input === undefined) {
      if (this.hasDefault) return this.defaultValue
      if (this.isRequired) throw new Error('missing required config field')
      return undefined
    }
    if (this.kind === 'union' && !this.values.includes(input)) {
      throw new Error(`value ${JSON.stringify(input)} is not in the declared union`)
    }
    return input
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
