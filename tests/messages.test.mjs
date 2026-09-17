/**
 * The card copy dictionary itself.
 *
 * `messagesFor` is the one place every string a person reads on the phone comes
 * from, so the two languages have to stay the same shape: a key that exists in
 * only one of them renders as `undefined` in a card, which is a failure the
 * reader sees and the deployment log does not.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LOCALES, messagesFor } from '../messages.js'
import { isAnswer } from '../results.js'
import { clipToBytes } from '../budget.js'

const source = readFileSync(new URL('../messages.js', import.meta.url), 'utf8')

/** The keys of one dictionary, read from the source rather than the export. */
function keysOf(locale) {
  const start = source.indexOf(`const ${locale} = {`)
  assert.notEqual(start, -1, `messages.js defines ${locale}`)
  const end = source.indexOf('\n}', start)
  return [...source.slice(start, end).matchAll(/^  ([A-Za-z][\w]*):/gm)].map(match => match[1])
}

test('both languages carry the same keys, and every locale resolves to one', () => {
  const zh = keysOf('zh')
  const en = keysOf('en')
  assert.ok(zh.length > 30, `the dictionary is not empty (${zh.length} keys)`)
  assert.deepEqual(zh.filter(key => !en.includes(key)), [], 'every Chinese key has an English counterpart')
  assert.deepEqual(en.filter(key => !zh.includes(key)), [], 'every English key has a Chinese counterpart')

  // Every key resolves to a usable value in every language, and an unknown
  // locale falls back to one of them rather than to nothing.
  assert.deepEqual(LOCALES, ['zh', 'en'])
  for (const locale of [...LOCALES, 'fr', undefined]) {
    const copy = messagesFor(locale)
    for (const key of zh) {
      const value = copy[key]
      assert.ok(
        typeof value === 'string' || typeof value === 'function',
        `${locale}: copy.${key} is a string or a formatter`,
      )
    }
  }
})

test('the copy a removed feature used is gone with it', () => {
  // A notice has no time limit by design, so the TTL strings that outlived that
  // decision are dead copy: they read as an offer to expire something that stays
  // valid indefinitely.
  for (const key of ['noticeExpired', 'noticeTtlPassed']) {
    assert.equal(source.includes(`${key}:`), false, `${key} is not defined`)
  }
  // `requestExpired` reads the same way but is live: the channel answers with it
  // when a card action names no request.
  assert.ok(source.includes('requestExpired:'), 'requestExpired is the channel\'s own toast and stays')
})

test('a turn answer is a message that speaks without calling a tool', () => {
  assert.equal(isAnswer({ text: 'Done.', hasToolCall: false }), true)
  // A message that both speaks and calls a tool is process, not the answer.
  assert.equal(isAnswer({ text: 'Let me check.', hasToolCall: true }), false)
  assert.equal(isAnswer({ text: '   ', hasToolCall: false }), false)
  assert.equal(isAnswer(undefined), false)
})

test('clipping never exceeds the budget it was given', () => {
  const marker = '…（内容过长已截断）'
  const long = '汉'.repeat(200)

  // The ordinary case: clipped, inside the bound, with the marker charged against it.
  const clipped = clipToBytes(long, marker, 60)
  assert.ok(
    Buffer.byteLength(clipped, 'utf8') <= 60,
    `clipped to ${Buffer.byteLength(clipped, 'utf8')} bytes`,
  )
  assert.ok(clipped.endsWith(marker), 'and it says it was clipped')

  // Text that already fits is returned untouched.
  assert.equal(clipToBytes('short', marker, 60), 'short')

  // The marker is wider than the budget. The bound still holds — the marker is what
  // gets cut, because a caller who asked for 4 bytes must not receive 27.
  const tiny = clipToBytes(long, marker, 4)
  assert.ok(
    Buffer.byteLength(tiny, 'utf8') <= 4,
    `a budget smaller than the marker is still honoured (${Buffer.byteLength(tiny, 'utf8')} bytes)`,
  )

  // A budget of zero yields nothing rather than the marker.
  assert.equal(clipToBytes(long, marker, 0), '')
})
