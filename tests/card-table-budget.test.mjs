/**
 * A card never carries more tables than the platform counts.
 *
 * The platform counts tables **across the whole card** and refuses it past five
 * (`230099 / card table number over limit`), which is how a nine-table answer came to be refused
 * whole and arrive nowhere (issue #74). These cases hold the two halves of the answer: a card is
 * kept inside the budget before it is sent, and what does not fit is **written as text rather than
 * dropped** — a reader loses the grid, not the numbers.
 *
 * Measured 2026-09-26 against this deployment's own tenant: five tables arrived, six were refused,
 * and five inside a single element arrived and rendered in full. `scripts/probe-card-limits.mjs`
 * reproduces that measurement.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CARD_TABLE_BUDGET, flattenExcessTables, flattenViewTables } from '../budget.js'
import { renderCard } from '../providers/feishu.js'

/** The copy a view's controls need; these cards declare none, so it is never read. */
const COPY = { answerPlaceholder: '输入回答', notePlaceholder: '补充说明', truncated: '……（已截断）' }

/** One Markdown table whose cells name `n`, so a case can tell which rows survived. */
const table = (n) => `表 ${n}\n\n| 列 A | 列 B |\n| --- | --- |\n| a${n} | b${n} |\n`

/** `count` tables in one string, in order. */
const many = (count, from = 1) => Array.from({ length: count }, (_, i) => table(from + i)).join('\n')

/** One line is a table rule when it is made of dashes/colons and contains a pipe. */
const isRule = (line) => line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line)

/** How many tables one string carries, counted the way the platform's own rule looks. */
function tablesInText(text) {
  const lines = String(text).split('\n')
  let count = 0
  for (let at = 0; at < lines.length - 1; at += 1) {
    if (lines[at].includes('|') && isRule(lines[at + 1])) count += 1
  }
  return count
}

/**
 * How many tables a rendered card carries, body and fold together.
 * @param card - the card document.
 * @returns the table count the platform would see.
 */
function tablesInCard(card) {
  let count = 0
  for (const element of card.body.elements) {
    if (typeof element.content === 'string') count += tablesInText(element.content)
    if (element.tag === 'collapsible_panel') {
      for (const inner of element.elements) count += tablesInText(inner.content)
    }
  }
  return count
}

/**
 * A view carrying the given tables in its body, and optionally in its fold.
 * @param options - how many tables go where.
 * @returns a channel-neutral view.
 */
function viewWith({ body = 0, fold = 0, each = 1 } = {}) {
  const view = { title: '结果 · 项目', tone: 'info', buttons: [], forms: [] }
  view.body = [many(body), '（正文结束）']
  if (fold > 0) view.details = { title: '思考过程', blocks: [many(fold, body + 1)] }
  void each
  return view
}

test('a card with more tables than the budget keeps only the budget as tables', () => {
  const card = renderCard(viewWith({ body: 9 }), () => COPY)
  assert.equal(tablesInCard(card), CARD_TABLE_BUDGET, `nine tables became ${tablesInCard(card)}`)
})

test('a table past the budget is written as text, not dropped', () => {
  const card = renderCard(viewWith({ body: 6 }), () => COPY)
  const text = card.body.elements.map(element => element.content ?? '').join('\n')
  // The sixth table's cells are still there — as a line of cells joined by ` · `.
  assert.ok(text.includes('a6') && text.includes('b6'), 'the flattened table keeps its cells')
  assert.ok(text.includes('a6 · b6'), 'and keeps them as one readable line')
  // While the first four stayed tables.
  assert.ok(text.includes('| --- | --- |'), 'the budgeted tables are still tables')
})

test('the fold shares the body\u2019s table budget, because the platform counts the card', () => {
  const card = renderCard(viewWith({ body: 3, fold: 3 }), () => COPY)
  assert.equal(tablesInCard(card), CARD_TABLE_BUDGET, 'body and fold do not each get a budget')
})

test('a card inside the budget is left exactly as it was', () => {
  let told = 0
  const card = renderCard(viewWith({ body: CARD_TABLE_BUDGET }), () => COPY, () => {}, () => { told += 1 })
  assert.equal(tablesInCard(card), CARD_TABLE_BUDGET, 'four tables stay four tables')
  assert.equal(told, 0, 'and nothing is reported as degraded')
})

test('the degradation is reported, with the count', () => {
  const reports = []
  renderCard(viewWith({ body: 9 }), () => COPY, () => {}, (report) => reports.push(report))
  assert.equal(reports.length, 1, 'one report per rendered card')
  assert.equal(reports[0].tables, 9 - CARD_TABLE_BUDGET, 'the number written as text')
})

test('only one note marks the flattened tables in one element', () => {
  const card = renderCard(viewWith({ body: 9 }), () => COPY)
  const text = card.body.elements.map(element => element.content ?? '').join('\n')
  const notes = text.split('（表格已转为文本）').length - 1
  assert.equal(notes, 1, 'a card of nine tables is not a card of nine notes')
})

test('a horizontal rule is not a table', () => {
  const state = { used: 0, budget: 0 }
  const out = flattenExcessTables('上面\n\n---\n\n下面\n', state)
  assert.equal(out.content, '上面\n\n---\n\n下面\n', 'a bare --- rule is left alone')
  assert.equal(state.flattened ?? 0, 0, 'and counted as nothing')
})

test('a budget of zero flattens every table and loses no cell', () => {
  const state = { used: 0, budget: 0 }
  const out = flattenExcessTables(many(3), state)
  assert.equal(tablesInText(out.content), 0, 'no table survives')
  for (const n of [1, 2, 3]) {
    assert.ok(out.content.includes(`a${n}`) && out.content.includes(`b${n}`), `table ${n} kept its cells`)
  }
  assert.equal(out.flattened, 3, 'three were flattened')
})

test('flattenViewTables reaches the body and the fold alike', () => {
  const view = viewWith({ body: 2, fold: 2 })
  const { view: flattened, flattened: count } = flattenViewTables(view)
  assert.equal(count, 4, 'every table in the view')
  assert.equal(tablesInText(flattened.body[0]), 0, 'the body is clean')
  assert.equal(tablesInText(flattened.details.blocks[0]), 0, 'and so is the fold')
})
