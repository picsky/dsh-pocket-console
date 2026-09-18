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
  controlNames,
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


test('every element in a card is named uniquely, however many questions it carries', async () => {
  // A card may not hold two elements of the same name, and the core names every
  // question's controls the same two things (`value`, `custom`). A card carrying three
  // questions therefore used to hold three elements called `value`, which the platform
  // refuses outright — so the message never arrived at all, and the only trace was the
  // delivery warning in the log. No fixture could catch it: they all accept any card.
  const { route, listenerOf } = await scaffold()
  await bind(route)

  const desktop = Promise.withResolvers()
  const result = listenerOf('user-questions/request').handler({
    questions: [
      { id: 'a', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] },
      { id: 'b', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] },
      { id: 'c', question: 'C?', multiSelect: true, options: [{ label: 'c1' }, { label: 'c2' }] },
      { id: 'd', question: 'D?' },
    ],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  const names = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (typeof node.name === 'string') names.push(node.name)
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)

  assert.ok(names.length >= 6, `the card names its controls: ${names.join(', ')}`)
  const seen = new Set()
  const repeated = names.filter(name => (seen.has(name) ? true : (seen.add(name), false)))
  assert.deepEqual(repeated, [], `no two elements may share a name (${names.join(', ')})`)

  // The names are namespaced per form, which is what keeps them unique — and the mapping
  // comes back on the submit payload so the core can read the values it receives.
  assert.deepEqual(
    [...new Set(names)].sort(),
    [
      'form_0', 'form_0_value',
      'form_1', 'form_1_value',
      'form_2', 'form_2_custom', 'form_2_value',
      'form_3', 'form_3_value',
    ],
    `each question has its own namespaced controls: ${[...new Set(names)].sort().join(', ')}`,
  )

  // Answering each one still works, which is what the namespacing must not break.
  const payloads = callbackValues(card)
  await clickCard(payloads.find(value => value.q === 'a' && value.v === 'a1'))
  await clickCard(payloads.find(value => value.q === 'b' && value.v === 'b2'))
  const multi = payloads.find(value => value.q === 'c' && value.submit === true)
  const checker = card.body.elements.find(element => element.name === 'form_2').elements
    .find(element => element.tag === 'checker').name
  const note = card.body.elements.find(element => element.name === 'form_2').elements
    .find(element => element.tag === 'input').name
  await clickCard(multi, { [checker]: ['c1'], [note]: '一条说明' })
  const free = payloads.find(value => value.q === 'd' && value.submit === true)
  const [freeName] = card.body.elements.find(element => element.name === 'form_3').elements
    .filter(element => element.tag === 'input')
    .map(element => element.name)
  await clickCard(free, { [freeName]: '自由作答' })

  assert.deepEqual(await result, {
    answers: [
      { id: 'a', selected: ['a1'] },
      { id: 'b', selected: ['b2'] },
      { id: 'c', selected: ['c1'], custom: '一条说明' },
      { id: 'd', selected: [], custom: '自由作答' },
    ],
  })
})


test('the submit reports the names the card gave its controls', async () => {
  // A card may not hold two elements of the same name, so the channel names its own
  // controls and tells the core what it called them. The core reads the answer through
  // that map rather than assuming the name it asked for survived to the card.
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{ id: 'only', question: '叫什么名字？' }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  const [control] = controlNames(card)
  const submit = callbackValues(card).find(value => value.submit === true)
  assert.equal(submit.submits?.value, control,
    'the submit reports the name the card gave the control it submits from')

  await clickCard(submit, { [control]: '小美' })
  assert.deepEqual(await result, { answers: [{ id: 'only', selected: [], custom: '小美' }] })
})


test('a card that reports no names is read under the ones the core asked for', async () => {
  // A card sent before the channel reported its names is still sitting in someone's
  // chat; pressing its submit reports nothing, and the answer is read under the name
  // the core put in the view. That fallback is why this is not a breaking change.
  const { route, listenerOf } = await scaffold()
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{ id: 'only', question: '叫什么名字？' }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(1200)

  const card = sentCard()
  const submit = callbackValues(card).find(value => value.submit === true)
  const { submits: _ignored, ...older } = submit
  await clickCard(older, { value: '小美' })
  assert.deepEqual(await result, { answers: [{ id: 'only', selected: [], custom: '小美' }] })
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

  // A multi-select question takes a typed answer beside its choices, the pair the
  // desktop card offers. The names are read back off the card rather than assumed: a
  // card has to keep every element name unique, so a channel namespaces them when one
  // request carries several questions — and reports the names it used on the submit.
  const own = card.body.elements.flatMap(element => element.elements ?? [])
  const choiceName = own.find(element => element.tag === 'checker').name
  const customName = own.find(element => element.tag === 'input')?.name
  assert.ok(customName, `a multi-select form carries a typed answer beside its choices: ${JSON.stringify(card)}`)

  await clickCard(submit, { [choiceName]: ['x', 'y'], [customName]: '带上发布说明' })
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

  const card = sentCard()
  const own = card.body.elements.flatMap(element => element.elements ?? [])
  const submit = callbackValues(card).find(value => value.submit === true)
  // Blank text is not an answer: submitted under the names the card gave its controls,
  // which the case reads back rather than assuming.
  await clickCard(submit, {
    [own.find(element => element.tag === 'checker').name]: ['x'],
    [own.find(element => element.tag === 'input').name]: '   ',
  })
  assert.deepEqual(
    await result,
    { answers: [{ id: 'pick', selected: ['x'] }] },
    'blank text is not an answer',
  )
})


test('a card the platform refuses for size is retried smaller', async () => {
  const { route, listenerOf } = await scaffold({ delaySeconds: 0 })
  await bind(route, { openId: 'ou_scanner' })
  const questions = listenerOf('user-questions/request')

  // The budget keeps cards far inside the documented limit, but the real ceiling
  // is documented outside this repository: a refusal costs one smaller retry.
  observed.failNextDelivery = 'invalid request: card content is too large'

  const desktop = Promise.withResolvers()
  questions.handler({
    questions: [{
      id: 'plan',
      question: '这份计划可以吗？',
      detail: '细'.repeat(3000),
      options: [{ label: '批准' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(120)

  assert.equal(observed.deliveryFailures, 1, 'the first delivery was refused')
  assert.equal(observed.created.length, 1, 'and the retry arrived')
  const retried = observed.created[0].data.content
  assert.match(retried, /内容过长已截断/, 'the retry carries the clipped text')
  assert.ok(
    callbackValues(JSON.parse(retried)).length > 0,
    'and keeps the decision available',
  )

  desktop.resolve({ answers: [] })
  await sleep(10)
})

test('a long detail is clipped to the card budget instead of being refused', async () => {
  const { route, listenerOf } = await scaffold({ delaySeconds: 0 })
  await bind(route, { openId: 'ou_scanner' })
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  questions.handler({
    questions: [{
      id: 'big',
      question: '很长的一份计划，需要你决定？',
      detail: '细'.repeat(20000),
      options: [{ label: '批准' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(120)

  // Feishu refuses a card body over 30 KB, so an unbounded plan would arrive as
  // no card at all. The clip keeps the message deliverable and says it clipped.
  const content = observed.created[0].data.content
  assert.ok(
    Buffer.byteLength(content, 'utf8') < 12 * 1024,
    `the card stays well inside the platform limit: ${Buffer.byteLength(content, 'utf8')} bytes`,
  )
  assert.match(content, /内容过长已截断/, 'and it says so')
  assert.ok(callbackValues(JSON.parse(content)).length > 0, 'while the decision stays available')

  desktop.resolve({ answers: [] })
  await sleep(10)
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
  const field = card.body.elements
    .flatMap(element => element.elements ?? [])
    .find(element => element.tag === 'input').name
  await clickCard(submit, { [field]: '按 B 方案来' })
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

