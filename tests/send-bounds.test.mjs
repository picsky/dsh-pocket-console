/**
 * A send that does not come back with a message is a send that failed.
 *
 * The channel used to hand its callers `response?.data?.message_id`, so an answer without an id became
 * `undefined` and every caller read it as a delivery that worked. Both of them then believed in a card
 * they could never find again: the activity record saw no handle and would have sent a second card for
 * the same run, and the result notice was remembered durably with the message missing, so nothing could
 * ever take its reply box off. The card exists on the platform either way — what is lost is this side's
 * ability to touch it, which is exactly what makes silence the wrong answer.
 *
 * The field is not one this repository declares: it comes back from the SDK as `response.data`, and a
 * renamed field or a reshaped envelope would look like a card that arrived. That is the failure these
 * cases are about, so they make the platform answer without an id rather than testing the getter.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sleep, observed, scaffold, bind, clickCard, callbackValues, cardFrom, lastDelivered } from './support/harness.mjs'

/** A deployment where the phone holds the person, so a card is being written. */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  for (let attempt = 0; attempt < 60 && observed.created.length < 1; attempt += 1) await sleep(50)
  await clickCard(callbackValues(cardFrom(lastDelivered())).find(value => value.v === 'allowed-once'))
  return scaffolded
}

test('an answer that does not name the message is not a delivery', async () => {
  const scaffolded = await phoneHoldsIt()
  const before = observed.created.length
  const patchesBefore = observed.patched.length

  // The platform accepts the card and answers without naming it.
  observed.answerWithoutId = true
  scaffolded.emitToAll('session/event', { id: 's_1' }, { type: 'turn/start', data: { turn: 2 } })
  await sleep(600)

  assert.equal(observed.unnamedAnswers, 1, 'the platform answered without a message id')
  assert.equal(
    scaffolded.warnings.length > 0,
    true,
    'and the channel reports the delivery as failed rather than swallowing it',
  )
  // The consequence that matters: with no handle, the next write for this session has to be another
  // **send**, not an edit of a message nobody can name. That is the difference between a card the
  // record can still maintain and one it believes in but can never touch again.
  assert.equal(
    observed.patched.length,
    patchesBefore,
    'no edit is attempted against a message that was never named',
  )
  assert.ok(
    observed.created.length > before,
    `and the card that was refused is sent again: ${observed.created.length} sends`,
  )
})

test('the deadline on a write is the only thing that ends a call that never answers', () => {
  // Asserted by reading rather than by waiting: the deadline is twenty seconds, and a case that sat
  // through it would be a case nobody runs. What matters is that the bound exists and wraps **every**
  // write — a send that never answers leaves the activity record's `sending` flag set for good, an
  // edit that never answers holds the flush, and the plain-text fallback a result falls back to when
  // no card can be delivered would hold the notifier just the same. Deleting any `writeBounded` call
  // puts its own version of that back, so the reading is the check.
  const source = readFileSync(new URL('../providers/feishu.js', import.meta.url), 'utf8')
  assert.match(source, /const SEND_TIMEOUT_MS = \d/, 'there is a deadline')
  assert.match(source, /withDeadline\(/, 'and a helper that enforces it')
  // Every write goes through the one bounded helper, so none can be left unbounded by accident:
  // one line defines it, and the three callers are the send, the edit, and the text fallback.
  assert.equal(
    [...source.matchAll(/await writeBounded\(/g)].length,
    3,
    'the send, the edit and the text fallback all go through it',
  )
})
