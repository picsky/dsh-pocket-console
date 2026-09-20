/**
 * The workspace each card on the phone belongs to, remembered against its message.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaces } from '../workspaces.js'

test('a delivered card can be named again by the message it lives in', () => {
  const workspaces = createWorkspaces()
  workspaces.record('om_1', 'my-app')
  assert.equal(workspaces.lookup('om_1'), 'my-app', 'what was recorded comes back')
  assert.equal(workspaces.lookup('om_2'), undefined, 'a message nothing was recorded for has no label')
  assert.equal(workspaces.lookup(undefined), undefined, 'and neither has a press that named no message')
})

test('a card with no workspace records nothing rather than an empty label', () => {
  const workspaces = createWorkspaces()
  workspaces.record('om_1', undefined)
  workspaces.record(undefined, 'my-app')
  workspaces.record('', 'my-app')
  assert.equal(workspaces.lookup('om_1'), undefined, 'a session with no workspace is not remembered')
  assert.equal(workspaces.lookup(''), undefined, 'a press with no message is not remembered')
})

test('the registry is bounded, and forgets the coldest card first', () => {
  const workspaces = createWorkspaces()
  for (let index = 0; index < 200; index += 1) workspaces.record(`om_${index}`, `ws-${index}`)
  assert.equal(workspaces.lookup('om_0'), undefined, 'the oldest card is forgotten')
  assert.equal(workspaces.lookup('om_199'), 'ws-199', 'the newest is kept')
  // Re-recording moves a card to the end, so it is not the next one evicted: a card that
  // has just been rewritten is the one a press is most likely to reach for.
  workspaces.record('om_100', 'ws-100-again')
  workspaces.record('om_1000', 'ws-1000')
  assert.equal(workspaces.lookup('om_100'), 'ws-100-again', 'a re-recorded card survives the next eviction')
})
