/**
 * The contract the Host holds this plugin to, asserted against the Host's own
 * algorithm rather than against the suite's stand-in.
 *
 * This exists because the stand-in lied once: it modelled volatility as a private
 * `isVolatile` flag while the Host reads `schema.meta.volatile`, so a `liveField`
 * that asked for a helper the resolved library did not have left every field
 * unmarked, the Host built no form for the entry, and the settings page was blank
 * for a real deployment — with the whole suite green. `issue #89`, fixed by #90.
 *
 * The three things asserted here are the three a release depends on:
 *
 * 1. `Config` produces a **form** on both shapes of the resolved library — the
 *    Host's own copy, which has `volatile()`, and an older copy a profile may
 *    legitimately hoist, which has only `extra()`.
 * 2. The editable set is exactly `client.js`'s `FIELDS`, so a field is either
 *    editable on the card or not volatile at all — never marked and unreachable.
 * 3. A marked field still resolves to the live reference the form writes through,
 *    because reading a captured value is the other half of the same failure.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formOf,
  isLiveReference,
  libraryShape,
  volatileForm,
  fieldNames,
} from './support/host-contract.mjs'

/** The four fields the settings card edits, in declaration order. */
const EDITABLE = ['delaySeconds', 'titlePrefix', 'resultNotify', 'debug']

/** The fields the Host must not expose: they are deployment-only, card-excluded. */
const NOT_EDITABLE = ['channel', 'channelConfig', 'resultNotifyCooldownSeconds', 'locale', 'mirrorTtlSeconds']

/**
 * Import a fresh instance of one module.
 *
 * `Config` is built once, when `index.js` is first evaluated, so a case that needs
 * the plugin to have been loaded against a different library has to defeat the
 * module cache. A query on the specifier does that for the module and for the stub
 * it imports, and leaves every other case on the shared instance.
 * @param specifier - a path relative to this file.
 * @param marker - the query that makes this load distinct.
 * @returns the module's namespace.
 */
const fresh = (specifier, marker) => import(`${specifier}?${marker}`)

/**
 * The plugin, with `volatile()` removed from the resolved schema library — a
 * profile that hoisted a schemastery older than the one its Host carries.
 *
 * The prototype is restored in a `finally`, and the stub instance is shared, so a
 * case that fails here cannot leave the rest of the file on the older shape. The
 * shape is asserted while the helper is still gone, because that is the only
 * moment the axis can be observed.
 * @returns the module's namespace, built against the older library.
 */
async function withoutHelper() {
  const stub = await import('./fixtures/stubs/schemastery.mjs')
  const field = Object.getPrototypeOf(stub.default.string())
  const helper = field.volatile
  assert.equal(typeof helper, 'function', 'the stand-in offers the helper to remove')
  delete field.volatile
  try {
    assert.deepEqual(
      libraryShape(stub.default),
      { helper: false, writer: true },
      'the library a profile may resolve: extra() and no volatile()',
    )
    return await fresh('../index.js', 'host-contract-without-helper')
  } finally {
    field.volatile = helper
  }
}

test('a resolved schema library that predates volatile() still gets the form', async () => {
  const { Config } = await withoutHelper()
  const form = formOf(Config)

  assert.equal(
    form.served,
    true,
    'a library with extra() and no volatile() must still write the marker the Host reads',
  )
  assert.deepEqual(form.fields, EDITABLE, 'and the editable set is the card, on that library too')
})

test('a marked field still resolves to the live reference the form writes through', async () => {
  const { Config } = await withoutHelper()
  const resolved = Config.resolve({ delaySeconds: 600 })

  assert.ok(
    isLiveReference(resolved.delaySeconds),
    'a marked field resolves to a reference, not to a snapshot of the value',
  )
  assert.equal(resolved.delaySeconds.get(), 600, 'which reads the value in force')
  assert.equal(
    isLiveReference(resolved.resultNotifyCooldownSeconds),
    false,
    'and a field the card does not edit stays an ordinary value',
  )
})

test('the Host serves the form on its own library and on an older one alike', async () => {
  const { Config } = await import('../index.js')
  const stub = await import('./fixtures/stubs/schemastery.mjs')

  // The axis itself, so the cases above are known to be walking it: the Host's own
  // library answers both calls, and `withoutHelper` asserts the other shape while
  // it holds it.
  assert.deepEqual(libraryShape(stub.default), { helper: true, writer: true })

  const current = formOf(Config)
  const stale = formOf((await withoutHelper()).Config)

  assert.equal(current.served, true, "the Host's own library gets a form")
  assert.equal(stale.served, true, 'so does a library older than the Host carries')
  assert.deepEqual(stale.fields, current.fields, 'and it offers the same fields, not a subset')
  assert.deepEqual(current.fields, EDITABLE, 'which is exactly the card')

  // The other half of the marker: reaching every non-editable field would open
  // settings the card cannot render anywhere, which is the same defect from the
  // other side. The exposure is asserted so a failure names the field that leaked.
  const exposed = new Set(formOf(Config).fields)
  for (const name of NOT_EDITABLE) {
    assert.ok(!exposed.has(name), `${name} must not be exposed as editable`)
  }
})

test('volatileForm is transcribed, not approximated', async () => {
  const { Config } = await import('../index.js')
  const config = Config.toJSON()

  // A marker on an ancestor carries its whole subtree, which is how `plainSchema`
  // and the Host's walk behave — the reason a plugin cannot mark a container and
  // expect only that container to be described.
  const markedRoot = volatileForm({ type: 'object', dict: { a: { type: 'number', meta: { volatile: true } }, b: { type: 'string' } } })
  assert.deepEqual(fieldNames(markedRoot), ['a'], 'only the marked leaf is described')

  // Nothing marked anywhere is no form at all — the exact shape of #89, kept here
  // so the negative case cannot rot into an assumption.
  assert.equal(
    volatileForm({ type: 'object', dict: { a: { type: 'number', meta: {} } } }),
    undefined,
    'an object with no marked field is no form',
  )

  // A root that is not an object is only a form when it carries the marker itself,
  // because the Host only descends objects.
  assert.equal(volatileForm({ type: 'union', meta: {} }), undefined, 'a union root is not descended')
  assert.deepEqual(
    fieldNames(volatileForm({ type: 'union', meta: { volatile: true } })),
    [],
    'and a root that is not an object has no leaf of its own to name',
  )

  // And the plugin itself: a Config whose marker is gone is the #89 shape, and the
  // host-contract exit has to report it as no form rather than as a form with no
  // fields.
  const stripped = {
    ...config,
    dict: Object.fromEntries(Object.entries(config.dict).map(([key, value]) => [key, { ...value, meta: {} }])),
  }
  assert.equal(formOf(stripped).served, false, 'a Config whose marker is gone serves nothing')
})
