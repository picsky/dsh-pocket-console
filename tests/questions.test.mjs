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
  SAME_ORIGIN,
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

  // The next question arrives with the rewrite, so its controls are read from there:
  // one question per card means the card that asked `a` never carried `b` at all.
  await clickCard(callbackValues(rewritten).find(value => value.q === 'b'))
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


test('a mirror window that passed with nobody collecting it is explained, not dropped', async () => {
  // A one-second window reached by waiting is the honest way to get here: the
  // window is a countdown, and a deployment that set it this short meets the same
  // state a sleeping browser meets an hour later.
  const { route, state, listenerOf, warnings } = await scaffold({ mirrorTtlSeconds: 1 })
  await bind(route)
  const questions = listenerOf('user-questions/request')

  const desktop = Promise.withResolvers()
  const result = questions.handler({
    questions: [{ id: 'a', question: 'A?', options: [{ label: 'a1' }] }],
    agent: { id: 's_agent' },
    signal: new AbortController().signal,
  }, () => desktop.promise)

  await sleep(1200)
  await clickCard(callbackValues(sentCard()).find(value => value.q === 'a'))
  await result

  const offered = (await state()).sync
  assert.equal(offered.sessionId, 's_agent', 'the decision is offered while its window is open')
  assert.equal(offered.expired, undefined, 'and says nothing about a window that has not passed')

  await sleep(1100)
  const sync = (await state()).sync
  assert.equal(sync.sessionId, 's_agent', 'the decision is still offered')
  assert.equal(sync.expired, true, 'and says its window has passed')
  assert.deepEqual(
    sync.answer,
    { answers: [{ id: 'a', selected: ['a1'] }] },
    'the answer is still there, because it is what the model received',
  )
  assert.ok(
    warnings.some(line => /过期/.test(line)),
    `the lapse is reported, because a composer was left waiting behind it: ${JSON.stringify(warnings)}`,
  )

  // A browser that did collect it is the other half: there is nothing left to
  // explain, so the decision stops being offered and no lapse is claimed.
  const collected = await scaffold({ mirrorTtlSeconds: 1 })
  await bind(collected.route)
  const asked = collected.listenerOf('user-questions/request')
  const desktopAtDesk = Promise.withResolvers()
  const pending = asked.handler({
    questions: [{ id: 'a', question: 'A?', options: [{ label: 'a1' }] }],
    agent: { id: 's_agent' },
    signal: new AbortController().signal,
  }, () => desktopAtDesk.promise)
  await sleep(1200)
  await clickCard(callbackValues(sentCard()).find(value => value.q === 'a'))
  await pending
  await sleep(1100)
  // Read twice before the browser speaks: a state read is what raises the warning,
  // and it must be raised once for the decision rather than once per read.
  assert.equal((await collected.state()).sync.expired, true, 'this window had passed too')
  assert.equal((await collected.state()).sync.expired, true, 'and is still offered')
  const claimed = collected.warnings.filter(line => /过期/.test(line)).length
  assert.equal(claimed, 1, `a lapse is stated once, not per read: ${JSON.stringify(collected.warnings)}`)
  const lapsedId = (await collected.state()).sync.id
  await collected.route('POST', '/__pocket/mirror', SAME_ORIGIN, { status: 'applied', syncId: lapsedId })
  assert.equal((await collected.state()).sync, null, 'a decision a browser applied is not offered again')
  desktopAtDesk.resolve('allowed-once')
})


test('a card asks one question at a time and steps to the next as each is answered', async () => {
  // A card is a flat document: it renders every text block first and then every
  // control. A card carrying several questions therefore showed every question's text
  // and then every question's buttons below it, so the reader could not tell which
  // button answered which question — and the typed-answer forms were identical, one
  // per question, with nothing to say which was which. One question per card fixes
  // that, and stepping the card as each is answered matches the desktop composer.
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

  // The card as it now stands: the first delivery, then each rewrite of it.
  const shown = () => (observed.patched.length === 0
    ? sentCard()
    : JSON.parse(observed.patched.at(-1).data.content))
  // Which questions the card offers controls for.
  const asked = (card) => [...new Set(callbackValues(card).map(value => value.q))]

  const first = shown()
  assert.match(JSON.stringify(first), /第 1\/4 题/, 'the card says which question it is asking')
  assert.match(JSON.stringify(first), /A\?/, 'and it carries that question')
  assert.deepEqual(asked(first), ['a'], 'only that question offers controls')
  assert.equal(
    first.body.elements.filter(element => element.tag === 'form').length,
    1,
    'one question means one form, so two controls can never share a name',
  )
  assert.equal(JSON.stringify(first).includes('B?'), false, 'the later questions are not on it yet')

  await clickCard(callbackValues(first).find(value => value.q === 'a' && value.v === 'a1'))
  await sleep(20)
  const second = shown()
  assert.match(JSON.stringify(second), /已答 1\/4/, 'the progress line advances')
  assert.match(JSON.stringify(second), /✅ a1/, 'the answered question stays visible as a receipt')
  assert.match(JSON.stringify(second), /第 2\/4 题/, 'and the card moved to the next question')
  assert.deepEqual(asked(second), ['b'], 'the answered question loses its controls')

  await clickCard(callbackValues(second).find(value => value.q === 'b' && value.v === 'b2'))
  await sleep(20)
  const third = shown()
  assert.deepEqual(asked(third), ['c'], 'a multi-select question is asked on its own')
  assert.equal(JSON.stringify(third).includes('D?'), false, 'and the question after it still waits')

  // The form's control names are read off the card: one question per card means one
  // form, and the channel still reports the names it used on the submit.
  const [checker, note] = controlNames(third)
  await clickCard(
    callbackValues(third).find(value => value.q === 'c' && value.submit === true),
    { [checker]: ['c1'], [note]: '一条说明' },
  )
  await sleep(20)
  const fourth = shown()
  assert.deepEqual(asked(fourth), ['d'], 'a question with no options is asked on its own')

  const [answer] = controlNames(fourth)
  await clickCard(
    callbackValues(fourth).find(value => value.q === 'd' && value.submit === true),
    { [answer]: '自由作答' },
  )

  assert.deepEqual(await result, {
    answers: [
      { id: 'a', selected: ['a1'] },
      { id: 'b', selected: ['b2'] },
      { id: 'c', selected: ['c1'], custom: '一条说明' },
      { id: 'd', selected: [], custom: '自由作答' },
    ],
  })
  await sleep(20)
  assert.match(
    JSON.stringify(shown()),
    /已回答/,
    'the last answer settles the request and the card says so',
  )
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
      detail: '细'.repeat(20_000),
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
      detail: '细'.repeat(60_000),
      options: [{ label: '批准' }],
    }],
    signal: new AbortController().signal,
  }, () => desktop.promise)
  await sleep(120)

  // An unbounded plan would be refused by the platform and arrive as no card at all, so the clip
  // keeps the message deliverable and says it clipped. Measured against what the platform actually
  // refuses (150 KB with room under the 164 KB that was rejected) and not against the 30 KB its
  // documentation claims: a budget built to the documented figure clipped a third of what fits.
  const content = observed.created[0].data.content
  assert.ok(
    Buffer.byteLength(content, 'utf8') < 150 * 1024,
    `the card stays inside the platform limit: ${Buffer.byteLength(content, 'utf8')} bytes`,
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
  const { route, listenerOf, agents } = await scaffold()
  await bind(route)
  const agent = { status: 'idle', session: { header: { cwd: '/work/my-app' } } }
  agents.set('s_q', agent)
  const questions = listenerOf('user-questions/request')
  void questions.handler({
    questions: [{ id: 'q', question: 'Q?', options: [{ label: 'ok' }] }],
    agent,
    signal: new AbortController().signal,
  }, () => Promise.withResolvers().promise)
  await sleep(1200)
  const rid = callbackValues(sentCard())[0].rid

  const expired = await clickCard({ rid: 'nope', v: 'ok' })
  assert.equal(expired.toast.type, 'warning')
  const retired = observed.patched.length
  assert.equal(retired, 1, 'the card the press came from is retired, since its request is not here')
  // The press names the message and nothing else, so this rewrite has no record to read a
  // workspace from — only what was remembered against that message when the card went out.
  const dead = JSON.parse(observed.patched.at(-1).data.content)
  assert.equal(dead.header.title.content, 'DSH 请求已结束 · my-app', 'and the retired card can still be named')

  const forged = await clickCard({ rid, q: 'q', v: '模型没提供过的选项' })
  assert.equal(forged.toast.type, 'warning', 'an answer no option offered must be refused')
  assert.equal(observed.patched.length, retired, 'a refused answer must not rewrite the live card')
})


test('a card whose request is gone stops looking answerable', async () => {
  // Live requests are held in memory, so a restart — or a crash — leaves the card on the
  // phone with nobody behind it. Pressing it answered with a toast and nothing else, so
  // the card went on looking like it would take an answer forever. The press names the
  // message it came from, which is enough to rewrite the card where it lies.
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', recipient: 'ou_stored' }
  const first = await scaffold({ delaySeconds: 0 }, { stored })
  void first.listenerOf('user-questions/request').handler({
    questions: [{ id: 'q', question: 'Q?', options: [{ label: 'ok' }] }],
    signal: new AbortController().signal,
  }, () => Promise.withResolvers().promise)
  await sleep(200)
  const button = callbackValues(sentCard()).find(value => value.v === 'ok')
  assert.ok(button, 'the card offers its option')

  // The restart: a new process loads the same deployment, and its registry is empty.
  await scaffold({ delaySeconds: 0 }, { stored })

  const refused = await clickCard(button)
  assert.equal(refused.toast.type, 'warning', 'the press is refused')
  assert.match(refused.toast.content, /已处理或已过期/, 'and says why')
  await sleep(20)

  const dead = JSON.parse(observed.patched.at(-1).data.content)
  assert.match(JSON.stringify(dead), /请求已结束/, 'the card is rewritten to say the request is over')
  assert.deepEqual(callbackValues(dead), [], 'and offers nothing left to press')
  assert.equal(JSON.stringify(dead).includes('ok'), false, 'the option went with the controls')
  // A card is never left untitled: the retirement keeps the prefix even though the
  // workspace it was sent with is not recoverable here — see the in-process retirement
  // above for the case where the message is one this process remembers.
  assert.equal(dead.header.title.content, 'DSH 请求已结束', 'and the retired card keeps its title')
})


test('a question card names the workspace, and steps it as the answer advances', async () => {
  const { route, listenerOf, agents } = await scaffold()
  await bind(route)
  const agent = { status: 'idle', session: { header: { cwd: '/work/my-app' } } }
  agents.set('s_q', agent)
  const questions = listenerOf('user-questions/request')

  void questions.handler({
    questions: [
      { id: 'a', header: '发布', question: '现在发布吗？', options: [{ label: '发布' }] },
      { id: 'b', header: '通知', question: '要通知团队吗？', options: [{ label: '通知' }] },
    ],
    agent,
    signal: new AbortController().signal,
  }, () => Promise.withResolvers().promise)
  await sleep(1200)

  const card = sentCard()
  assert.equal(card.header.title.content, 'DSH 提问 · 第 1/2 题 · my-app', 'the first question names the workspace')

  // Answering rewrites the same card to the next question, and the rewrite is the only
  // thing on screen — a title that dropped the workspace here would leave the reader
  // unable to tell which session the second question belongs to.
  await clickCard(callbackValues(card).find(value => value.q === 'a'))
  await sleep(20)
  const next = JSON.parse(observed.patched.at(-1).data.content)
  assert.equal(next.header.title.content, 'DSH 提问 · 第 2/2 题 · my-app', 'and so does the next one')
})
