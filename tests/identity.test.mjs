/**
 * What a card calls the session it belongs to: the label, and the join onto a title.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { titleOf, workspaceLabel } from '../identity.js'

test('a workspace label names the directory a session runs in', () => {
  // Every case is written as a literal and expected to hold on any platform. The first
  // version of this used `path.basename`, which on POSIX treats a backslash as an
  // ordinary filename character — so the Windows cases passed on the author's machine
  // and failed on CI, and a Windows-shaped workspace would have been nameless there.
  assert.equal(workspaceLabel('/Users/ann/work/my-app'), 'my-app', 'a POSIX path')
  assert.equal(workspaceLabel('C:\\Users\\ann\\work\\my-app'), 'my-app', 'a Windows path')
  assert.equal(workspaceLabel('\\\\server\\share\\proj'), 'proj', 'a UNC path')
  assert.equal(workspaceLabel('//server/share/proj'), 'proj', 'a UNC path in POSIX spelling')
  assert.equal(workspaceLabel('/Users/ann/work/my-app/'), 'my-app', 'a trailing separator')
  assert.equal(workspaceLabel('/Users/ann//work///my-app'), 'my-app', 'repeated separators')
  assert.equal(workspaceLabel('/Users/ann/work/./my-app'), 'my-app', 'a current-directory segment')
  assert.equal(workspaceLabel('/Users/ann/work/my app'), 'my app', 'a name with a space')
  assert.equal(workspaceLabel('/Users/ann/工作区'), '工作区', 'a name that is not Latin')
})

test('a session with nothing to name stays unnamed', () => {
  // Each of these would otherwise put something invented on the card: a bare
  // separator, an empty label, or the whole path where a name belongs.
  assert.equal(workspaceLabel(undefined), undefined, 'no working directory at all')
  assert.equal(workspaceLabel(null), undefined, 'a header field that is not a string')
  assert.equal(workspaceLabel(''), undefined, 'an empty string')
  assert.equal(workspaceLabel('   '), undefined, 'whitespace alone')
  assert.equal(workspaceLabel('/'), undefined, 'a POSIX root, which has no name')
  assert.equal(workspaceLabel('C:\\'), undefined, 'a Windows drive root, which has no name')
  assert.equal(workspaceLabel('\\\\\\\\'), undefined, 'separators alone')
  assert.equal(workspaceLabel('/tmp/..'), undefined, 'a reference to a parent directory names nothing this session is')
})

test('a long workspace name is clipped so one title cannot crowd out a card', () => {
  const long = `/${'x'.repeat(200)}`
  assert.equal(workspaceLabel(long), 'x'.repeat(40), 'a name longer than the limit is cut to it')
  assert.equal(workspaceLabel(`/${'x'.repeat(40)}`), 'x'.repeat(40), 'a name exactly at the limit is kept in full')
  assert.equal(workspaceLabel(`/${'x'.repeat(41)}`), 'x'.repeat(40), 'the next character is the one dropped')
  // The limit is about characters, not UTF-16 code units: a name whose 40th character is an
  // emoji must not come back as half of one. A lone surrogate goes into the card verbatim
  // and renders as a broken glyph, which is worse than a shorter name.
  const emoji = `/${'x'.repeat(39)}🚀`
  const clipped = workspaceLabel(emoji)
  assert.equal(clipped, `${'x'.repeat(39)}🚀`, 'a character that is two code units is kept whole')
  assert.equal([...clipped].length, 40, 'and it still counts as forty characters')
  assert.equal(/[\uD800-\uDBFF]$/.test(clipped), false, 'the label never ends on a lone high surrogate')
  assert.equal(workspaceLabel(`/${'x'.repeat(40)}🚀`), 'x'.repeat(40), 'and a name that is too long stops before it')
})

test('a title keeps what the card is, and adds the workspace when there is one', () => {
  // The regression this pins: an early version returned the label's join alone, so a
  // card with no workspace lost the words that said what it was.
  assert.equal(titleOf('DSH 结果', undefined), 'DSH 结果', 'no workspace leaves the title as it was')
  assert.equal(titleOf('DSH 结果', ''), 'DSH 结果', 'an empty label is no label')
  assert.equal(titleOf('DSH 结果', 'my-app'), 'DSH 结果 · my-app', 'a workspace is named beside it')
  assert.equal(titleOf('Result', 'my-app'), 'Result · my-app', 'and the join does not depend on the language')
})
