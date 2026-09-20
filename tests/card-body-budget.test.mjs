/**
 * Every card this channel sends fits in the body the platform will accept.
 *
 * The two per-part budgets bound a card string by string and element by element; the platform refuses
 * a *body*. Between those two facts is a hole that measures about eleven megabytes wide — the
 * allowance is 120 elements at 32 KB each, against a measured refusal at 164 KB — so a view that
 * stayed inside both of its own budgets could still be refused whole, and a refused card is not a
 * shorter card: it is no card, with only a delivery warning to show for it.
 *
 * These cases hand the renderer the worst views the core's budgets permit, directly, because that is
 * the only way to reach the shape: no deployment builds one, and a scenario that produced one on
 * purpose would be testing the scenario. The real cards the suite sends weigh 0.7–10 KB, so the case
 * that matters most here is the **last** one — that nothing normal is touched.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCard } from '../providers/feishu.js'
import { CARD_BODY_BUDGET, CARD_TEXT_BUDGET } from '../budget.js'

/** The copy a view's controls need; the renderer reads the placeholders out of it. */
const COPY = {
  answerPlaceholder: '输入回答',
  notePlaceholder: '补充说明',
  truncated: '……（已截断）',
}

/** What the platform actually receives for one card, counted on the request body it rides in. */
const requestBytes = (card) => Buffer.byteLength(JSON.stringify({
  params: { receive_id_type: 'open_id' },
  data: { receive_id: 'ou_x', msg_type: 'interactive', content: JSON.stringify(card) },
}), 'utf8')

/** Every markdown string in a card, in element order. */
const texts = (card) => card.body.elements
  .filter(element => typeof element.content === 'string')
  .map(element => element.content)

/** One string that costs `bytes` on the wire, in Chinese (three bytes a character). */
const textOf = (bytes) => '汉'.repeat(Math.floor(bytes / 3))

/**
 * A view whose every part is at the limit the core's budgets allow.
 * @param options - how many body strings and fold blocks, and how big each is.
 * @returns a channel-neutral view.
 */
function worstView({ body = 1, blocks = 0, each = CARD_TEXT_BUDGET } = {}) {
  const view = { title: 'DSH 结果', tone: 'info', buttons: [], forms: [] }
  view.body = Array.from({ length: body }, () => textOf(each))
  if (blocks > 0) view.details = { title: '思考过程', blocks: Array.from({ length: blocks }, () => textOf(each)) }
  return view
}

test('the worst view the budgets permit is brought inside the body budget', () => {
  // Four full-budget body strings and a fold of many: what the per-part budgets allow and the body
  // budget has to survive. 120 is `CARD_ELEMENT_BUDGET`, so this is the element count as well.
  const card = renderCard(worstView({ body: 4, blocks: 116 }), () => COPY)
  assert.ok(
    requestBytes(card) <= CARD_BODY_BUDGET,
    `the rendered body fits the budget: ${requestBytes(card)} bytes`,
  )
})

test('the fold is what is given up first', () => {
  const view = worstView({ body: 1, blocks: 8 })
  const card = renderCard(view, () => COPY)
  assert.equal(
    card.body.elements.some(element => element.tag === 'collapsible_panel'),
    false,
    'a fold that does not fit is dropped rather than shortened',
  )
  // The answer itself is untouched: the fold is the part a card can lose whole and still be the same
  // card, which is why it goes before any text does.
  assert.equal(texts(card)[0], view.body[0], 'and the answer is still whole')
})

test('text comes down only when there is no fold left to drop', () => {
  // No fold at all, and the body strings alone are over: the only move left is the text.
  const card = renderCard(worstView({ body: 4, blocks: 0 }), () => COPY)
  assert.ok(
    requestBytes(card) <= CARD_BODY_BUDGET,
    `the body still fits after the text comes down: ${requestBytes(card)} bytes`,
  )
  // Structure survives whatever the text does — a card whose elements were dropped to make room would
  // be a different card, and one with no elements at all is the card-shaped nothing this guards.
  assert.ok(card.body.elements.length > 0, 'and the card still has its elements')
  assert.ok(texts(card).every(text => text.length > 0), 'with something in each of them')
})

test('a card that already fits is not touched at all', () => {
  // The case that matters most: this is a safety net, and a net that cost something on the way past
  // would be paid for by every ordinary card. The suite's real cards weigh 0.7–10 KB.
  const view = {
    title: 'DSH 结果 · my-app',
    tone: 'info',
    body: ['构建已经通过。', '**回复这条消息**即可把下一步交给这个会话。'],
    buttons: [{ label: '允许一次', tone: 'primary', payload: { v: 'allowed-once' } }],
    forms: [{ payload: { nid: 'n1' }, fieldId: 'value', submitLabel: '发送' }],
    details: { title: '思考过程', blocks: ['把剩下的两个 shard 做完', '## 方案', '1. 第1步'] },
  }
  const card = renderCard(view, () => COPY)
  assert.equal(requestBytes(card) < 20 * 1024, true, `an ordinary card stays small: ${requestBytes(card)}`)
  assert.deepEqual(texts(card), view.body, 'every string is exactly what the view asked for')
  assert.equal(
    card.body.elements.some(element => element.tag === 'collapsible_panel'),
    true,
    'and the fold it came with is still there',
  )
})

test('a card the platform refused for size would have been caught here', () => {
  // The number the budget exists for, stated as an assertion so it cannot drift out of the file: the
  // tenant refused a 164 KB body and accepted 131 KB, and the budget sits under both.
  const card = renderCard(worstView({ body: 4, blocks: 116 }), () => COPY)
  const bytes = requestBytes(card)
  assert.ok(bytes < 131 * 1024, `well under the largest body this tenant accepted: ${bytes}`)
  assert.ok(bytes < 164 * 1024, `and under the one it refused: ${bytes}`)
})

test('what the per-part budgets leave unbounded, measured', () => {
  // Why a body budget exists at all, as a number rather than an argument. The two per-part budgets
  // bound a string and an element count; neither bounds the body, so the ceiling they leave between
  // them is the product of the two — and the product is what a body budget has to survive. Measured
  // on a small sample per element and extrapolated, because the real thing is eleven megabytes and
  // materialising it to prove a point is a poor use of a test runner.
  const sample = 4 * 1024
  const each = '汉'.repeat(sample)
  const unbounded = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: 'x' },
    body: { elements: Array.from({ length: 120 }, () => ({ tag: 'markdown', content: each })) },
  }
  const measured = requestBytes(unbounded)
  const extrapolated = Math.round(measured * (CARD_TEXT_BUDGET / sample))
  // Around eleven megabytes against a refusal at 164 KB — a factor of about seventy. Recorded as an
  // assertion so the size of the hole cannot quietly change under the budget that closes it.
  assert.ok(
    extrapolated > 1024 * 1024,
    `with every element at full budget the body would be about a megabyte: measured ${measured} at `
    + `${sample} per element, ${extrapolated} at ${CARD_TEXT_BUDGET}`,
  )
})
