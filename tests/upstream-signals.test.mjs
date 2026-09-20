/**
 * The two mechanisms that fail without a symptom have to leave a count in the log.
 *
 * Neither of these cases is about behaviour, because neither mechanism has a behaviour a reader can
 * see when it stops. The desk-presence rule rests on `source.rpcId`, a field no type declares: if the
 * gateway stops stamping it, every phone decision still works and every setting still applies — the
 * plugin simply never concludes that somebody is at the desk, so it keeps sending cards to a person
 * who is sitting right there. The callback subscription rests on an event name matching between the
 * app's subscription and the dispatcher's registration; if they drift, every button still renders and
 * pressing one does nothing at all.
 *
 * From inside this process an absent request id is indistinguishable from a person who is genuinely
 * away — both are a human message with nothing beside it — so there is no assertion here that says
 * "the mechanism is broken". What is asserted is that the *count* exists, because that is what turns
 * "the phone keeps interrupting me" into a fact a deployment can check. The subscription names are
 * asserted for the same reason: they are two separate strings that have to agree, the line makes them
 * comparable, and a silence where the line should be is the failure this catches.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { sleep, scaffold, bind, observed, cardFrom, lastDelivered, clickCard, callbackValues } from './support/harness.mjs'

/**
 * A deployment where the phone holds the person, so a later human message is comparable against it.
 * @returns the scaffold result.
 */
async function phoneHoldsIt() {
  const scaffolded = await scaffold({ delaySeconds: 1 })
  await bind(scaffolded.route)
  const approval = scaffolded.listenerOf('approval/request')
  void approval.handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => Promise.withResolvers().promise,
  )
  for (let attempt = 0; attempt < 60 && observed.created.length < 1; attempt += 1) await sleep(50)
  await clickCard(callbackValues(cardFrom(lastDelivered())).find(value => value.v === 'allowed-once'))
  return scaffolded
}

test('a human message without the request id is counted, and the count is readable', async () => {
  const scaffolded = await phoneHoldsIt()

  // A person speaking from the phone: a `{ kind: 'user' }` message and no request id beside it. The
  // plugin must not read this as somebody at the desk — and it must say that it did not.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'user/message',
    data: { source: { kind: 'user' } },
  })
  await sleep(50)

  assert.equal(
    scaffolded.infos.some(line => line.includes('没带 request id')),
    true,
    'the first human message without a request id says so, once: ' + JSON.stringify(scaffolded.infos),
  )
})

test('a human message carrying the request id proves the rule is alive', async () => {
  const scaffolded = await phoneHoldsIt()

  // What the browser's session controller stamps. This is the only signal for "somebody is at the
  // desk", and nothing in the repository's types promises it exists.
  scaffolded.emitToAll('session/event', { id: 's_1' }, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'req-1' } },
  })
  await sleep(50)

  assert.equal(
    scaffolded.infos.some(line => line.includes('判据生效了')),
    true,
    'the desk signal is reported as alive: ' + JSON.stringify(scaffolded.infos),
  )
  // And it moves the side, which is the behaviour the count is there to explain.
  assert.equal((await scaffolded.state()).priority, 'desk', 'a person typing at the desk takes it back')
})

test('the connection says which event names it subscribes to', async () => {
  const scaffolded = await phoneHoldsIt()
  const said = scaffolded.infos.join('\n')
  // The two names that have to agree for a press to arrive. Both are logged, so a deployment whose
  // buttons stop working can compare what it subscribed to against what it presses.
  assert.match(said, /card\.action\.trigger/, 'the callback name is said out loud')
  assert.match(said, /im\.message\.receive_v1/, 'and so is the direct-message event name')
})
