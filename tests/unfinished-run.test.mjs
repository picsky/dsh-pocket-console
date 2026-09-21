/**
 * A run that stopped short still owes the phone a card **with a reply box**.
 *
 * The failure this file exists for: a turn that ended on anything but `completed` produced no notice
 * at all, so the only card the reader had was the activity card — which carries no controls by design,
 * and is rewritten four times a second while it is live. After an error the phone was a dead end, and
 * getting the work moving again meant walking back to the desk.
 *
 * Two gates had to be opened, and both are pinned here:
 *
 * 1. `turn/end` accepted only `completed` — an `error` never reached the notice at all.
 * 2. Even then, `isAnswer` asks for a message with text and no tool call — and a run that fails most
 *    often ends on the very message that called the tool that failed, which has no text.
 *
 * The control cases matter as much as the positive ones: a turn that **did** finish still gets a card
 * only when it ended on an answer, and a stop somebody already asked for (`aborted`) still gets none.
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
  cardFrom,
  cardsSent,
  lastDelivered,
} from './support/harness.mjs'

/** The title every result card starts with. */
const RESULT_TITLE = 'DSH 结果'

/** Every result card this deployment has sent, newest last. */
const resultCards = () =>
  cardsSent().filter(entry => String(entry.card?.header?.title?.content ?? '').startsWith(RESULT_TITLE))

/** The markdown a card shows on its face. */
const face = (card) =>
  (card?.body?.elements ?? []).filter(el => el.tag === 'markdown').map(el => el.content).join('\n')

/**
 * Put the phone in charge by answering a card, which is what takes the head start away.
 * @param scaffolded - the scaffold result.
 */
async function takeOverFromThePhone(scaffolded) {
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  await sleep(1100)
  await clickCard(callbackValues(cardFrom(lastDelivered())).find(value => value.v === 'allowed-once'))
}

/**
 * A deployment where the phone holds the person and one session is watched.
 * @returns the scaffold result and the emitter for that session.
 */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1, resultNotify: 'idle' })
  await bind(scaffolded.route)
  await takeOverFromThePhone(scaffolded)
  scaffolded.agents.set('s_1', {
    status: 'idle',
    followup: () => {},
    session: { header: { cwd: '/work/my-app' } },
  })
  return scaffolded
}

/**
 * Drive one turn that stops, and wait past the notify window.
 *
 * The last message is the one that called the tool — which is how a failing run usually ends, and it
 * carries no text at all. That is the shape this file is about.
 * @param scaffolded - the scaffold result.
 * @param reason - the turn's end reason, as the harness records it.
 * @param options - `said` adds an earlier message with text.
 */
async function stoppedRun(scaffolded, reason, { said } = {}) {
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这个模块改好' }] },
  })
  emit({ type: 'turn/start', data: { turn: 1 } })
  if (said !== undefined) {
    emit({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: said }] } },
    })
  }
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 2,
      message: {
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'pwsh', input: '{}' }],
      },
    },
  })
  emit({ type: 'turn/end', data: { turn: 1, reason } })
  await sleep(1_300)
}

test('an errored run still gets a card, and it can be replied to', async () => {
  const scaffolded = await phoneHoldsIt()
  await stoppedRun(scaffolded, { kind: 'error', error: { message: 'Command failed with exit code 1' } })

  const cards = resultCards()
  assert.equal(cards.length, 1, 'the stopped run came to the phone')
  const card = cards[0].card
  assert.equal(
    callbackValues(card).some(value => value.submit === true),
    true,
    'and it carries the reply box the whole thing is for',
  )
  assert.match(face(card), /出错/, 'the face says the run did not finish')
  assert.match(face(card), /exit code 1/, 'and carries the reason a reader can act on')
})

test('a run cut off by its output ceiling gets a card too, saying which it was', async () => {
  const scaffolded = await phoneHoldsIt()
  await stoppedRun(scaffolded, { kind: 'max-tokens' })

  const cards = resultCards()
  assert.equal(cards.length, 1, 'the truncated run came to the phone')
  assert.equal(
    callbackValues(cards[0].card).some(value => value.submit === true),
    true,
    'with a reply box, which is the point',
  )
  assert.match(face(cards[0].card), /上限/, 'and the face names the reason rather than the error')
})

test('what the run managed to say is preferred over the headline', async () => {
  const scaffolded = await phoneHoldsIt()
  await stoppedRun(scaffolded, { kind: 'error' }, { said: '我先看失败的用例。' })

  const cards = resultCards()
  assert.equal(cards.length, 1, 'the run came to the phone')
  assert.match(face(cards[0].card), /我先看失败的用例/, 'the words it did say are the face')
  assert.equal(/这一轮出错了/.test(face(cards[0].card)), false, 'so the headline is not needed')
})

test('a completed run that ended on a tool call is still not a result', async () => {
  // The old behaviour, kept on purpose: an intermediate round ends on a tool call, and a card asking
  // the reader to reply to something that was never said is worse than no card.
  const scaffolded = await phoneHoldsIt()
  const emit = (event) => scaffolded.emitToAll('session/event', { id: 's_1' }, event)
  emit({
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这个模块改好' }] },
  })
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'pwsh', input: '{}' }] },
    },
  })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(1_300)

  assert.equal(resultCards().length, 0, 'a turn that finished on a tool call is not a result')
})

test('a stop somebody already asked for gets no card', async () => {
  // `aborted` is the person (or the loop) having decided already. A card asking "what now?" a second
  // after somebody pressed stop is noise, and it would arrive on the phone for a stop made at the desk.
  const scaffolded = await phoneHoldsIt()
  await stoppedRun(scaffolded, { kind: 'aborted', reason: 'user cancelled' })

  assert.equal(resultCards().length, 0, 'a cancelled turn is not reported to the phone')
})
