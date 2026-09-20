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
 * The cap the module's own constant declares.
 *
 * Restated here rather than imported, because the point of the case is to notice the constant moving:
 * asserting `held <= TRACK_CAPACITY` with the constant imported would keep passing if the constant
 * itself were raised to a number that is not a bound in practice.
 */
const BOUND = 256

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

test('the bound holds however the map is filled', async () => {
  // What this case can prove: the map stays capped, and the sessions held are the ones a reader is
  // closest to hearing about. Measured against the cap itself rather than against `SESSIONS` — an
  // earlier version compared with the number of sessions it had driven, which is hundreds above the
  // bound, so a map that stopped evicting altogether still looked bounded.
  //
  // What it cannot prove, and does not claim: the branch where *every* track is waiting on its calm
  // window. Reproducing that needs the timers to still be pending at the moment the bound is
  // consulted, and in this host they are not — measured, not assumed: driving 400 sessions with a
  // 20 ms window and with a 30 s window both leave 144 tracks held, i.e. the idle branch either way.
  // The rule that branch belongs to is still the right one (`forgetColdest` used to skip every
  // waiting track and then stop, which is arithmetically not a bound), but it is unverified at
  // runtime and `internal/review-2026-09.md` says so rather than implying otherwise.
  const { notifier, spoke } = setup()

  for (let index = 0; index < SESSIONS; index += 1) spoke(`pending_${index}`)
  spoke('pending_overflow')

  const held = notifier.trackedSessions()
  assert.ok(
    held <= BOUND,
    `the map stays capped: ${held} held after ${SESSIONS + 1} sessions`,
  )
  assert.ok(held >= BOUND / 2, `and it gives up about half rather than everything: ${held}`)
  assert.ok(held > 0, 'while still holding the sessions it is working on')
})
