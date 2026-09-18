/**
 * Stand-in for `@deepseek-ai/dsh-storage-domain`.
 *
 * Holds what the real one holds — a durable, schema-declared KV keyed by domain and
 * table — in module scope, so it outlives the plugin being reloaded exactly as the real
 * medium outlives a restart. `resetDurable()` is how a case starts from an empty medium;
 * the plugin never clears it, because forgetting on unload is the bug being fixed.
 */

/** The real hub's grammar for domain and table names; a name it would reject fails here. */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * Declare one table.
 * @param schema - the record schema from the zod stub.
 * @returns the table declaration.
 */
export function domainTable(schema) {
  return { valueSchema: schema }
}

/**
 * Declare one domain, validating what the real helper validates.
 * @param spec - the domain declaration.
 * @returns the same spec.
 */
export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(String(spec?.name))) {
    throw new Error(`domain name outside UNIT_NAME_RE: ${String(spec?.name)}`)
  }
  if (!Number.isInteger(spec?.version) || spec.version < 0) {
    throw new Error(`domain version must be a non-negative integer: ${String(spec?.version)}`)
  }
  for (const name of Object.keys(spec?.tables ?? {})) {
    if (!UNIT_NAME_RE.test(name)) throw new Error(`table name outside UNIT_NAME_RE: ${name}`)
  }
  return spec
}

/** Durable records: `domain/table` to a key-to-record map. Survives a reload. */
const durable = new Map()

/** Start from an empty medium. Called by a case, never by the plugin. */
export function resetDurable() {
  durable.clear()
}

/** The durable records of one table, created on first open. */
function recordsOf(domain, table) {
  const name = `${domain}/${table}`
  const existing = durable.get(name)
  if (existing !== undefined) return existing
  const created = new Map()
  durable.set(name, created)
  return created
}

/** Whether one stored value satisfies the declared shape. */
function accepts(schema, value) {
  if (schema === undefined) return true
  if (schema.kind === 'object') {
    if (value === null || typeof value !== 'object') return false
    return Object.entries(schema.shape).every(([field, fieldSchema]) => (
      value[field] === undefined ? fieldSchema.optional === true : accepts(fieldSchema, value[field])
    ))
  }
  return typeof value === schema.kind
}

/** One table handle, in the shape the domain layer hands out. */
function tableHandle(domain, table, schema) {
  const records = recordsOf(domain, table)
  return {
    get: (key) => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size },
    async put(key, value) {
      // The real layer validates at the durable boundary, so a record this seam would
      // refuse must not look stored here either.
      if (!accepts(schema, value)) {
        throw new Error(`${domain}/${table} refused a record for ${key}`)
      }
      records.set(key, value)
    },
    async delete(key) {
      return records.delete(key)
    },
    async update(key, fn) {
      const current = records.get(key)
      if (current === undefined) throw new Error(`missing key: ${key}`)
      const next = fn(current)
      records.set(key, next)
      return next
    },
  }
}

/**
 * The mounted `ctx.storageDomain` service.
 * @returns the facility, with `open` over the durable records.
 */
export function createStorageDomain() {
  return {
    async open(spec) {
      const tables = new Map()
      for (const [name, declaration] of Object.entries(spec.tables)) {
        tables.set(name, tableHandle(spec.name, name, declaration.valueSchema))
      }
      return {
        name: spec.name,
        table(name) {
          const handle = tables.get(name)
          if (handle === undefined) throw new Error(`undeclared table: ${name}`)
          return handle
        },
        async close() {},
      }
    },
  }
}
