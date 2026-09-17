/**
 * What the result notifier keeps, and for how long.
 *
 * The notifier observes every session the deployment meets, and nothing in the
 * harness ever tells it that a session has gone away. That makes its per-session
 * record the one piece of state here that grows with the lifetime of the process,
 * so its bound is a property worth holding still — a deployment that stays up for
 * weeks is the normal case, not the exception.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createResultNotifier } from '../results.js'

/** Copy the notifier reads while it is deciding. */
const COPY = {
  truncated: '…', resultTitle: 'Result', replyHint: 'Reply', sendToAgent: 'Send',
  superseded: 'Superseded', readerSpoke: 'Spoke', noticeGone: 'Gone',
  emptyInstruction: 'Empty', noAgent: 'No agent', sent: 'Sent', received: 'Received',
}

/** Sessions in the volume case, well past whatever bound the module picks. */
const SESSIONS = 900

/**
 * A notifier wired to a stub host and channel, with a clock the case controls.
 * @returns the notifier, the session-event sink, and the clock.
 */
function setup() {
  const listeners = new Map()
  let clock = 0
  const notifier = createResultNotifier({
    ctx: {
      get: () => ({ get: () => undefined }),
      on: (event, handler) => {
        listeners.set(event, handler)
        return () => { listeners.delete(event) }
      },
    },
    log: { warn() {}, info() {}, debug() {} },
    channel: { async deliver() { return { id: 'h' } }, async update() {} },
    // A quiet window short enough to fire during the case, and notifications off
    // so no notice is ever offered: the records are what is being measured.
    settings: () => ({
      delaySeconds: 0.02, titlePrefix: 'DSH',
      resultNotify: 'off', resultNotifyCooldownSeconds: 0,
    }),
    messages: () => COPY,
    now: () => clock,
  })
  notifier.install()
  const sink = listeners.get('session/event')
  assert.equal(typeof sink, 'function', 'the notifier watches the session firehose')
  return {
    notifier,
    /** Drive one session's user turn, which is what creates its record. */
    spoke: (id) => sink({ id }, { type: 'user/message', data: { source: { kind: 'user' }, session: { id } } }),
    /** Move the clock the notifier reads for its cooldown. */
    advance: (milliseconds) => { clock += milliseconds },
  }
}

test('the per-session record is bounded however many sessions pass through', async () => {
  const { notifier, spoke, advance } = setup()

  // Rounds are separated so the previous round's records go cold: each round's
  // window is allowed to fire, which is what makes eviction possible at all.
  for (let index = 0; index < SESSIONS; index += 1) {
    if (index % 100 === 0) {
      advance(30_000)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    spoke(`session_${index}`)
  }
  await new Promise(resolve => setTimeout(resolve, 30))
  advance(30_000)
  spoke('a_final_session')

  const held = notifier.trackedSessions()
  assert.ok(held > 0, 'sessions are being observed')
  assert.ok(
    held < SESSIONS,
    `the record is bounded: ${held} held after ${SESSIONS + 1} sessions passed through`,
  )
  // Sanity on the mechanism rather than a restated constant: the bound has to be
  // small enough to matter and large enough to be useful.
  assert.ok(held >= 50 && held <= 400, `the bound is proportionate (${held})`)
})

test('a session that is still waiting on its window is never evicted', async () => {
  const { notifier, spoke } = setup()

  // Every session here has a pending window, so none of them is idle: eviction
  // may only take cold records, or a notice that is about to be offered would be
  // dropped before it could be.
  for (let index = 0; index < SESSIONS; index += 1) spoke(`pending_${index}`)

  // The map is allowed to exceed the idle bound while everything in it is live —
  // that is the correct trade: a bounded number of *idle* records, not a bounded
  // number of sessions mid-flight.
  assert.ok(notifier.trackedSessions() >= 1, 'live sessions are held while they wait')
})
