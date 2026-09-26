/**
 * The chrome the settings card draws for itself, and the type scale it states.
 *
 * The card is rendered inside the Plugins page, whose own layout is `ItemDetail`: a breadcrumb, a
 * 20px title, a one-liner, and 32px between the sections of a page. Two things follow, and both
 * were wrong in front of a person before they were wrong here:
 *
 * - **It must not draw a second frame.** The page owns the frame, so a bordered, rounded, tinted
 *   box around the card's content is one frame inside another. That is what a reader reported as
 *   "设置项外层还套了一层圆角容器" — the settings items arrived inside a box that exists to say
 *   nothing.
 * - **It must state its whole type scale.** The page sets a colour and no size, so text that names
 *   no size inherits the browser's default: a row came out at one size beside a `<code>` the
 *   browser sets at 13.33px in another family, and the block read as sizes nobody chose ("忽大忽
 *   小"). The examples below are the ones measured on DSH 0.1.7-rc.2: `S.card` names no
 *   `fontSize`, and `S.description` — the line above the QR code — was never defined at all, so
 *   that one rendered at the page's inherited size while everything around it was 12–13px.
 *
 * The card is hand-written against a React stand-in in `client.test.mjs`, which mounts it as a
 * whole; these cases read the style table itself, because what is being pinned is which values the
 * card *states*, and a stand-in with no layout engine cannot answer that.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

/** The style table's own text: `const S = {` up to the property that closes it. */
const styleTable = (() => {
  const start = source.indexOf('const S = {')
  assert.notEqual(start, -1, 'the browser half still declares its style table')
  return source.slice(start, source.indexOf('\n    }', start))
})()

/** One style entry's source text, from its key to the next entry at the same depth. */
const entry = (name) => {
  const start = styleTable.search(new RegExp(`^      ${name}:`, 'm'))
  assert.notEqual(start, -1, `S.${name} is declared`)
  const rest = styleTable.slice(start + 1)
  const end = rest.search(/^      [A-Za-z]+:/m)
  return end === -1 ? rest : rest.slice(0, end)
}

test('every style the card uses is one it declares', () => {
  const declared = new Set([...styleTable.matchAll(/^      ([A-Za-z]+):/gm)].map((match) => match[1]))
  // `FIELDS.find` is not `S.find`: the name has to stand alone, not end another identifier.
  const used = new Set([...source.matchAll(/(?<![A-Za-z0-9_$])S\.([A-Za-z]+)/g)].map((match) => match[1]))

  assert.deepEqual(
    [...used].filter((key) => !declared.has(key)).sort(),
    [],
    'a style that is used but never declared renders as no style at all',
  )
  assert.deepEqual(
    [...declared].filter((key) => !used.has(key)).sort(),
    [],
    'a declared style nothing reads is a table that no longer describes the card',
  )
})

test('the card draws no frame of its own, and states the type scale it inherits from', () => {
  const card = entry('card')

  for (const frame of ['border', 'borderRadius', 'background', 'padding']) {
    assert.doesNotMatch(card, new RegExp(`\\b${frame}\\b`), `the page owns the frame, so S.card has no ${frame}`)
  }
  // Everything inside inherits from here, so a size has to be named: a value the page does not set
  // is a value the reader's browser chooses.
  assert.match(card, /fontSize:/, 'the card names the body size everything inside inherits')
  assert.match(card, /lineHeight:/, 'and the line height that goes with it')
})

test('every radius is one the theme publishes', () => {
  const radii = [...source.matchAll(/borderRadius:\s*'([^']+)'/g)].map((match) => match[1])

  assert.ok(radii.length >= 5, `the card rounds ${radii.length} things, which is too few to be the card`)
  assert.deepEqual(
    radii.filter((radius) => !radius.startsWith('var(--dsw-radius-') && radius !== '50%').sort(),
    [],
    'a literal radius is a radius that stops following the theme the moment it changes',
  )
})

test('an identifier is drawn in the theme\'s monospace at the size the card chose', () => {
  const codes = [...source.matchAll(/h\('code'[^)]*/g)].map((match) => match[0])

  assert.ok(codes.length >= 2, `the card renders ${codes.length} identifiers, which is too few to be the pair it shows`)
  for (const code of codes) {
    assert.match(code, /style: S\.code/, `an unstyled <code> is the browser's 13.33px: ${code}`)
  }
  assert.match(entry('code'), /fontFamily: MONO/, 'and that style names the monospace family explicitly')
  assert.match(entry('code'), /fontSize:/, 'with a size, so it cannot disagree with the row it sits in')
})
