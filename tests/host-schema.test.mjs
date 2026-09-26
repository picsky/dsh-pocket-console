/**
 * The shared host-schema walk, pinned against the real libraries it stands in for.
 *
 * `tests/support/host-schema.mjs` is used from two places that cannot both be wrong in
 * the same way: the unit suite, through the schemastery stand-in, and
 * `scripts/probe-installed-form.mjs`, which loads the library a deployment resolved —
 * the real one, out of a real profile. The probe's copy of this walk is what the
 * composition job exercises, and the first version of it got two things wrong that no
 * stand-in could have shown: it dropped every marked **leaf** (a marked leaf has no
 * `dict`, so "nothing below this" and "this is the leaf" were the same answer), and it
 * read values through `~standard.validate`, which the library 0.1.6 ships does not
 * publish.
 *
 * These cases therefore run the walk against a **real** schemastery when one is
 * resolvable, and against the stand-in otherwise, and they assert the two properties
 * the probe depends on: the marked leaves are named, and a marked field is found to be
 * a live reference through whichever resolution call the library publishes.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { markedFields, resolutionsOf, inspectSchema } from './support/host-schema.mjs'

/** The shape the Host ships the browser, as this plugin's four editable fields. */
const marked = (volatile) => ({
  type: 'object',
  dict: {
    a: { type: 'number', meta: volatile ? { volatile: true } : {} },
    b: { type: 'string', meta: {} },
    nested: { type: 'object', meta: {}, dict: { c: { type: 'string', meta: { volatile: true } } } },
  },
})

test('a marked leaf is named, and the walk descends objects only', () => {
  assert.deepEqual(markedFields(marked(true)), ['a', 'nested.c'], 'the marked leaves, in order')
  assert.deepEqual(markedFields(marked(false)), ['nested.c'], 'only what is marked, wherever it sits')
  assert.deepEqual(markedFields({ type: 'object', dict: { plain: { type: 'string', meta: {} } } }), [], 'nothing marked is nothing served')

  // A marker on an ancestor carries its whole subtree, and a marker inside a marked
  // subtree is not reached — the two rules `volatileForm` implements. A marked subtree
  // whose leaves are all marked carries no leaf of its own, so it names only the marked
  // leaves below it: the projection describes fields, not containers.
  assert.deepEqual(
    markedFields({ type: 'object', dict: { only: { type: 'string', meta: { volatile: true } } } }),
    ['only'],
    'a marked string is a marked leaf',
  )
  assert.deepEqual(
    markedFields({ type: 'object', dict: { group: { type: 'object', meta: { volatile: true }, dict: { x: { type: 'string', meta: {} } } } } }),
    [],
    'a marked container whose leaves are unmarked names nothing',
  )
  assert.deepEqual(
    markedFields({ type: 'object', dict: { group: { type: 'object', meta: { volatile: true }, dict: { x: { type: 'string', meta: { volatile: true } } } } } }),
    ['group.x'],
    'and a marked container with marked leaves names them',
  )
})

test('resolution is asked for by capability, and every shape is reported', () => {
  const shapes = (schema) => resolutionsOf(schema, { a: 1 }).map(entry => entry.shape)

  // The standard-schema interface: the shape 0.1.7's schemastery publishes.
  assert.deepEqual(
    shapes({ '~standard': { validate: (value) => ({ value: { a: value.a } }) } }),
    ['~standard.validate'],
  )
  // A plain `validate` returning the value itself.
  assert.deepEqual(shapes({ validate: (value) => ({ a: value.a }) }), ['validate'])
  // The static `Schema.resolve`, which older copies publish as a named export.
  assert.deepEqual(shapes({ resolve: (value) => ({ a: value.a }) }), ['Schema.resolve'])
  // A callable schema carrying its own `resolve`.
  const callable = Object.assign((value) => ({ a: value.a }), { resolve: (value) => ({ a: value.a }) })
  assert.deepEqual(shapes(callable), ['Schema.resolve', 'call .resolve', 'call'])
  // A library that publishes none of them is reported, not guessed at.
  assert.deepEqual(shapes({}), [], 'no call shape answers')
})

test('a value read through a library that publishes no standard interface is still live', () => {
  // The regression the composition job found: 0.1.6's library is asked through
  // `validate`/`resolve`, and a probe that insisted on `~standard` reported "no live
  // reference" for a schema that resolves perfectly.
  const live = { get: () => 600 }
  const schema = {
    type: 'object',
    dict: { delaySeconds: { type: 'number', meta: { volatile: true } } },
    validate: () => ({ delaySeconds: live }),
  }
  const inspected = inspectSchema(schema, { delaySeconds: 600 })
  assert.deepEqual(inspected.fields, ['delaySeconds'])
  assert.equal(inspected.live, true, 'the marked field is a live reference')
  assert.deepEqual(inspected.shapes, ['validate'], 'and the call that answered is named')
})

test('a library that answers no call shape is reported as such, not as no form', () => {
  const schema = {
    type: 'object',
    dict: { delaySeconds: { type: 'number', meta: { volatile: true } } },
  }
  const inspected = inspectSchema(schema, {})
  assert.deepEqual(inspected.fields, ['delaySeconds'], 'the form would be served')
  assert.equal(inspected.live, false, 'but no call could resolve a value')
  assert.deepEqual(inspected.shapes, [], 'and none is claimed to have')
})

test('a resolved value with a field called value is not mistaken for the wrapper', () => {
  // The standard interface answers `{ value, issues }`; a plain `validate` answers the
  // config itself, and one of this plugin's fields happens to be named `value` in other
  // schemas. Unwrapping on the presence of `value` alone handed the caller a field
  // instead of a config — silently, and only for a schema shaped that way.
  const live = { get: () => 1 }
  const schema = {
    type: 'object',
    dict: { delaySeconds: { type: 'number', meta: { volatile: true } } },
    validate: () => ({ value: 'a field named value', delaySeconds: live }),
  }
  const inspected = inspectSchema(schema, {})
  assert.equal(inspected.live, true, 'the resolved config is read as a config')
  assert.deepEqual(inspected.shapes, ['validate'])
})
