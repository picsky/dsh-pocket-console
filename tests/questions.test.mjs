/**
 * Question shapes: options, multi-select, free text, accumulation, and forged input.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sleep,
  clickCard,
  scaffold,
  bind,
  callbackValues,
  sentCard,
  observed,
} from './support/harness.mjs'

test('answers a single-select question from its option button', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{
      id: 'deploy',
      header: '发布',
      question: '现在发布到生产吗？',
      options: [{ label: '发布', description: '立即上线' }, { label: '取消' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  assert.match(JSON.stringify(card), /立即上线/, 'an option description must reach the card body')
  assert.equal(JSON.stringify(card).includes('column_set'), false, 'each option takes its own full-width row')

  const chosen = callbackValues(card).find(value => value.v === '发布')
  assert.ok(chosen, 'the option label must be offered as a button')
  assert.equal(chosen.q, 'deploy')

  const typed = callbackValues(card).find(value => value.submit === true)
  assert.ok(typed, 'a single-select question must also accept a typed answer')
  assert.equal(typed.q, 'deploy')

  await clickCard(chosen)
  assert.deepEqual(await result, { answers: [{ id: 'deploy', selected: ['发布'] }] })
})


test('accumulates answers until every question is answered', async () => {
  const { route, listenerOf, state } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [
      { id: 'a', question: 'A?', options: [{ label: 'a1' }] },
      { id: 'b', question: 'B?', options: [{ label: 'b1' }] },
    ],
    agent: { id: 's_agent' },
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)
  assert.equal((await state()).sync, null, 'nothing is mirrored before the phone decides')

  const values = callbackValues(sentCard())
  const partial = await clickCard(values.find(value => value.q === 'a'))
  assert.match(partial.toast.content, /1\/2/, 'a partial answer must not settle the request')

  await sleep(20)
  assert.equal(observed.patched.length, 1, 'the card is rewritten so the recorded answer is visible')
  const rewritten = JSON.parse(observed.patched[0].data.content)
  assert.match(JSON.stringify(rewritten), /已答 1\/2/, 'the progress line advances')
  assert.match(JSON.stringify(rewritten), /✅ a1/, 'the chosen answer stays visible')
  assert.deepEqual(
    [...new Set(callbackValues(rewritten).map(value => value.q))],
    ['b'],
    'the answered question loses its controls while the open one keeps them',
  )

  await clickCard(values.find(value => value.q === 'b'))
  assert.deepEqual(await result, {
    answers: [
      { id: 'a', selected: ['a1'] },
      { id: 'b', selected: ['b1'] },
    ],
  })

  // The phone decided, so the desktop composer still waits: the Host offers the
  // accepted answer for the browser half to apply there.
  const sync = (await state()).sync
  assert.equal(sync.sessionId, 's_agent', 'the mirror names the session whose composer waits')
  assert.deepEqual(sync.questions, ['a', 'b'])
  assert.deepEqual(sync.answer, {
    answers: [
      { id: 'a', selected: ['a1'] },
      { id: 'b', selected: ['b1'] },
    ],
  }, 'the mirror carries exactly the answer the request settled with')
})


test('accepts a multi-select form submission with a typed answer beside the choices', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{
      id: 'pick',
      question: '选哪些？',
      multiSelect: true,
      options: [{ label: 'x' }, { label: 'y' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  assert.ok(submit, 'a multi-select question needs a submit button')
  assert.match(JSON.stringify(card), /"name":"custom"/, 'a multi-select form carries a typed answer beside its choices')

  await clickCard(submit, { value: ['x', 'y'], custom: '带上发布说明' })
  assert.deepEqual(await result, {
    answers: [{ id: 'pick', selected: ['x', 'y'], custom: '带上发布说明' }],
  })
})


test('a multi-select submission without typed text carries no custom answer', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{
      id: 'pick',
      question: '选哪些？',
      multiSelect: true,
      options: [{ label: 'x' }, { label: 'y' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const submit = callbackValues(sentCard()).find(value => value.submit === true)
  await clickCard(submit, { value: ['x'], custom: '   ' })
  assert.deepEqual(
    await result,
    { answers: [{ id: 'pick', selected: ['x'] }] },
    'blank text is not an answer',
  )
})


test('accepts a free-text form submission when the question offers no options', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{ id: 'note', question: '有什么要补充的？' }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  assert.match(JSON.stringify(card), /"tag":"input"/, 'a no-option question needs a text field')

  const submit = callbackValues(card).find(value => value.submit === true)
  await clickCard(submit, { value: '按 B 方案来' })
  assert.deepEqual(await result, {
    answers: [{ id: 'note', selected: [], custom: '按 B 方案来' }],
  })
})


test('rejects an unknown request id and a forged option label', async () => {
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')
  void questions.handler({
    questions: [{ id: 'q', question: 'Q?', options: [{ label: 'ok' }] }],
    signal: new AbortController().signal,
  }, () => Promise.withResolvers().promise)
  await sleep(1200)
  const rid = callbackValues(sentCard())[0].rid

  const expired = await clickCard({ rid: 'nope', v: 'ok' })
  assert.equal(expired.toast.type, 'warning')

  const forged = await clickCard({ rid, q: 'q', v: '模型没提供过的选项' })
  assert.equal(forged.toast.type, 'warning', 'an answer no option offered must be refused')
  assert.equal(observed.patched.length, 0, 'a refused answer must not close the request')
})

