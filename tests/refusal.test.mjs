/**
 * What the platform refused decides what is given up.
 *
 * The old judge was one word list and one set of codes, and both were wrong for the failure that
 * mattered: a card refused for its table count (`230099 / card table number over limit`) was not
 * recognized, so nothing was degraded and the card was retried four times before being dropped in
 * silence (issue #74). The same set called `230020` (a frequency limit), `230002` ("the bot is not
 * in the group") and `10002` ("the bot is not in the chat") size refusals, none of which is about
 * the card's size at all.
 *
 * These cases pin the vocabulary, one real platform payload at a time.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRefusal, refusalIsRetryable } from '../budget.js'

/** The error an SDK axios call throws for a refused card: the code and msg live in the response. */
const axiosRefusal = (code, msg) => Object.assign(new Error('Request failed with status code 400'), {
  response: { data: { code, msg }, status: 400 },
})

/** The refusal this issue is about, verbatim from the platform. */
const TABLE_REFUSAL = axiosRefusal(
  230099,
  'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; ',
)

test('the table refusal that lost the card is recognized', () => {
  const refusal = classifyRefusal(TABLE_REFUSAL)
  assert.equal(refusal.kind, 'tables')
  assert.equal(refusal.code, 230099, 'and the platform code is kept for the log')
  assert.match(refusal.message, /card table number over limit/)
})

test('a card-content failure with any other reason is not read as a size refusal', () => {
  const refusal = classifyRefusal(axiosRefusal(230099, 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: element exceeds the limit; ErrorValue: element;'))
  assert.equal(refusal.kind, 'elements', 'the element count is its own kind')
})

test('an unnamed card-content failure is its own kind, so the strongest degradation can run', () => {
  assert.equal(classifyRefusal(axiosRefusal(230099, 'Failed to create card content, ext=ErrCode: 200810')).kind, 'content')
})

test('a size refusal is still a size refusal', () => {
  assert.equal(classifyRefusal(axiosRefusal(230025, 'The length of the message content reaches its limit.')).kind, 'size')
  // The wording the two existing fallback cases use, with no code at all.
  assert.equal(classifyRefusal(new Error('card content is too large')).kind, 'size')
})

test('a rate limit is a rate limit, and worth waiting out', () => {
  const refusal = classifyRefusal(axiosRefusal(230020, 'This operation triggers the frequency limit.'))
  assert.equal(refusal.kind, 'frequency')
  assert.equal(refusalIsRetryable(refusal), true, 'the same card can arrive after a wait')
})

test('the codes that are not about the card are not size refusals any more', () => {
  const notInGroup = classifyRefusal(axiosRefusal(230002, 'The bot can not be outside the group.'))
  const notInChat = classifyRefusal(axiosRefusal(10002, 'Bot can NOT be out of the chat'))
  assert.equal(notInGroup.kind, 'other', '230002 is about the group, not the card')
  assert.equal(notInChat.kind, 'other', '10002 is about the chat, not the card')
  assert.equal(refusalIsRetryable(notInGroup), false, 'and sending the identical card again cannot fix either')
})

test('a transport failure carries no refusal, and is worth the same card again', () => {
  const refusal = classifyRefusal(new Error('socket hang up'))
  assert.equal(refusal.kind, 'other')
  assert.equal(refusal.code, undefined, 'nothing came back from the platform')
  assert.equal(refusalIsRetryable(refusal), true, 'an identical retry is exactly right here')
})

test('a plain string refusal still reads', () => {
  assert.equal(classifyRefusal('card content is too large').kind, 'size')
})
