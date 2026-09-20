/**
 * The card a notice was sent as belongs to the notice, not to a map beside it.
 *
 * This is a case about a *shape*, not about behaviour, and it is here because behaviour cases could
 * not have caught the bug it prevents. A notice's card has to survive until the notice is rewritten
 * — when the reader replies, when a newer result supersedes it — so the card and the notice have
 * exactly one lifetime. That was expressed as two containers: the notice map, and a second map keyed
 * by message. Three code paths each had to remember to clean both, and one of them could not: a card
 * superseded while its send was still in flight had no message to be keyed by yet, so the write that
 * eventually recorded the card found no notice to record it against and left the card's full text in
 * memory for the life of the process.
 *
 * No behavioural case would have failed. The card still arrived, still got rewritten, still carried
 * its answer and its fold — everything a reader can see was correct. What was wrong was only that a
 * copy was kept that nothing would ever release, and the only external sign of it is memory that
 * grows with the number of runs.
 *
 * So this asserts the ownership directly: the sent card is a property of the notice, and there is no
 * second container of cards. It reads the source rather than exercising the module, because the
 * guarantee is about how the state is held — and a reading is what a reviewer would have to do
 * anyway. If it fails, the question is not "which assertion do I relax" but "why does the card need a
 * lifetime of its own".
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** The module under test, as text: the shape is the subject, so the source is the evidence. */
const SOURCE = readFileSync(new URL('../results.js', import.meta.url), 'utf8')

test('the sent card is held by the notice, not by a second container', async () => {
  // A map keyed by message and a notice map keyed by rid are two accounts of one thing. The names to
  // look for are the ones a second container would naturally be given, so this fails on the obvious
  // reintroduction rather than on an exotic one.
  const secondContainer = /\bconst\s+(views|cards|viewByMessage|sentViews)\s*=\s*new\s+(Map|Set)\(/.exec(SOURCE)
  assert.equal(
    secondContainer,
    null,
    'results.js holds sent cards in a second container again: ' + String(secondContainer?.[1])
    + '. A card must live on the notice it belongs to, or three rewrite paths have to keep two '
    + 'containers in step and one of them will not.',
  )
})

test('the view is written on the notice and read back off it', async () => {
  // One writer, and it writes to the notice it looked up under the rid.
  assert.match(
    SOURCE,
    /notice\[VIEW\]\s*=/,
    'the delivered card is recorded on the notice',
  )
  // One reader, shared by every rewrite path — retiring, replying, closing the offer. A per-path
  // lookup is how the paths drift apart.
  assert.match(
    SOURCE,
    /function cardOf\(/,
    'and every rewrite resolves the card through one lookup',
  )
  const reads = [...SOURCE.matchAll(/cardOf\(/g)].length
  assert.ok(
    reads >= 3,
    'the retiring path, the offer path and the reply path all go through that one lookup (found '
    + reads + ' uses)',
  )
})

test('a card superseded mid-delivery is not kept', async () => {
  // The precise leak: the record is guarded by the notice still being there. Without the guard the
  // card is written onto a notice that has already been dropped, which is a card nothing can ever
  // rewrite — the case the whole ownership change exists for.
  assert.match(
    SOURCE,
    /if \(notice !== undefined && handle !== undefined\) notice\[VIEW\] = card/,
    'the card is only kept while the notice that would rewrite it is still live',
  )
})
