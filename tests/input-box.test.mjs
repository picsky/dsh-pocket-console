/**
 * The box a person types an instruction into, and what the card says about it.
 *
 * The platform caps an `input` at **1000 characters** and the cap cannot be raised — the accepted range
 * is `[1,1000]` — so the box is the one surface on the card where the reader runs out of room without
 * being told. Two failures follow from leaving it at the platform defaults, and both were measured
 * rather than imagined: the box arrives as a **single-line** field, so on a phone a whole first prompt
 * is typed one visible line at a time and cannot be read back; and no copy anywhere names the limit, so
 * a reader who types past it learns about it from a client-side error, with what they wrote already
 * gone. `internal/feishu-limits.md` §7 carried this as its only ❌ row.
 *
 * These cases hold the renderer and the copy to each other: the field's own declaration is checked, the
 * number in the copy is checked against the constant the field is sent with, and the placeholder is
 * measured against the platform's own 100-character cap so stating the limit cannot itself overflow.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCard, INPUT_MAX_LENGTH, INPUT_ROWS } from '../providers/feishu.js'
import { LOCALES, messagesFor } from '../messages.js'

/**
 * A view whose controls are the two free-text boxes a card can carry: one answering a question, and one
 * typing an answer beside a multi-select's choices.
 * @param options - a placeholder the view names itself, when the case is about that.
 * @returns the view handed to the renderer.
 */
const view = ({ placeholder } = {}) => ({
  title: '结果',
  tone: 'info',
  body: ['正文'],
  buttons: [],
  forms: [
    {
      payload: { rid: 'r1' },
      fieldId: 'value',
      submitLabel: '提交',
      ...(placeholder === undefined ? {} : { placeholder }),
    },
    {
      payload: { rid: 'r2' },
      fieldId: 'choice',
      customFieldId: 'custom',
      submitLabel: '提交',
    },
  ],
})

/** Every input element in a card, in element order, however the forms are laid out. */
const inputsOf = (card) => card.body.elements
  .filter(element => element.tag === 'form')
  .flatMap(element => element.elements)
  .filter(element => element.tag === 'input')

test('the platform cap is the one the code is built around', () => {
  // Stated rather than inherited: `max_length` is optional on the platform and defaults to this same
  // number, so the only thing that keeps the field honest is that the number is written down here.
  assert.equal(INPUT_MAX_LENGTH, 1000, 'the platform accepts max_length in [1,1000] and no higher')
  assert.ok(INPUT_ROWS >= 1, 'a box shows at least one row')
  assert.ok(INPUT_ROWS < 5, 'and fewer than the platform default, which the result card pays for twice')
})

test('every input box is multi-line and carries the cap, in both languages', () => {
  for (const locale of LOCALES) {
    const card = renderCard(view(), () => messagesFor(locale))
    const inputs = inputsOf(card)
    assert.equal(inputs.length, 3, `${locale}: the view's two forms offer an input each, plus the note`)

    for (const input of inputs) {
      assert.equal(
        input.input_type,
        'multiline_text',
        `${locale}: ${input.name} is a box a prompt can be read back in`,
      )
      assert.equal(input.rows, INPUT_ROWS, `${locale}: ${input.name} shows the channel's own row count`)
      assert.equal(
        input.max_length,
        INPUT_MAX_LENGTH,
        `${locale}: ${input.name} is held to the cap the card states`,
      )
      assert.equal(input.placeholder.tag, 'plain_text', `${locale}: ${input.name} names itself in plain text`)
    }
  }
})

test('the copy beside a box states the limit the box is held to, and fits the platform cap for a placeholder', () => {
  for (const locale of LOCALES) {
    const copy = messagesFor(locale)
    for (const key of ['answerPlaceholder', 'notePlaceholder', 'workPlaceholder']) {
      const text = copy[key]
      assert.ok(
        text.includes(String(INPUT_MAX_LENGTH)),
        `${locale}: copy.${key} states the ${INPUT_MAX_LENGTH}-character limit ('${text}')`,
      )
      // A placeholder is capped at 100 characters by the platform. Saying "up to 1000 characters" is
      // longer than saying nothing, so the sentence that names the limit is the one most able to
      // overflow it — and a placeholder that is refused takes the whole card with it.
      assert.ok(
        [...text].length <= 100,
        `${locale}: copy.${key} fits the 100-character placeholder cap (${[...text].length})`,
      )
    }
  }
})

test('the box a person types a new task into is the one that says the limit on the card', () => {
  // The next-task box is the long one — it is a whole prompt, not an answer — so it is the box the
  // limit is most likely to be reached in, and the only one whose copy comes from the view rather
  // than from the renderer's fallback.
  for (const locale of LOCALES) {
    const copy = messagesFor(locale)
    const card = renderCard(view({ placeholder: copy.workPlaceholder }), () => copy)
    const named = inputsOf(card).map(input => input.placeholder.content)
    assert.ok(
      named.includes(copy.workPlaceholder),
      `${locale}: the view's own placeholder is what the card shows ('${named.join(' / ')}')`,
    )
    assert.ok(
      named.some(text => text.includes(String(INPUT_MAX_LENGTH))),
      `${locale}: so the box that carries a whole prompt is a box that states its limit`,
    )
  }
})
