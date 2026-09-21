/**
 * The fence around the browser half's own routes.
 *
 * These are the branches a person never sees working, which is the whole risk: `sameOrigin` refuses a
 * mutation, the body limit refuses an oversized one, and the method and body checks refuse requests
 * that are simply wrong — all of them returning errors only to a caller that is misbehaving. A
 * security boundary with no case is a boundary nobody has watched hold.
 *
 * The fence itself (the connection's trust check, which answers 401) is covered by `npm run e2e`,
 * because it needs a real server and a real browser session. What is here is everything that runs
 * *after* a caller is trusted: the checks that decide whether this particular request may do what it
 * asks.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SAME_ORIGIN, scaffold } from './support/harness.mjs'

/** One route reply, narrowed to what these cases assert on. */
const answer = async (route, method, path, headers, body) => await route(method, path, headers, body)

test('a mutation from another site is refused', async () => {
  const { route } = await scaffold()
  // A browser sends `Origin` on every cross-site write, and it is the one header an attacker cannot
  // forge from a page: refusing it is what stops a site the reader happens to have open from
  // unbinding their deployment through their own browser session.
  const captured = await answer(route, 'POST', '/__pocket/unbind', { origin: 'http://evil.example' })

  assert.equal(captured.status, 403, 'a cross-origin mutation is refused')
  assert.equal(JSON.parse(captured.body).error, 'cross-origin request refused')
})

test('a read is answered the same way from anywhere, because it is a read', async () => {
  const { route } = await scaffold()
  // The same-origin rule is applied to mutations only: a GET changes nothing, and the trust fence
  // ahead of it is what decides who may see the state at all.
  const captured = await answer(route, 'GET', '/__pocket/state', { origin: 'http://evil.example' })

  assert.notEqual(captured.status, 403, 'reading the state is not a cross-origin refusal')
})

test('a missing origin is accepted, because a script and a probe send none', async () => {
  const { route } = await scaffold()
  // Deliberately not a refusal: a same-origin request from something that is not a browser carries no
  // `Origin`, and the routes are inside the connection's trust fence wherever a deployment has one.
  const captured = await answer(route, 'POST', '/__pocket/unbind', { origin: undefined })

  assert.notEqual(captured.status, 403, 'a caller with no origin is not refused as cross-site')
})

test('a body past the limit is refused as the caller\'s mistake', async () => {
  const { route } = await scaffold()
  // The limit keeps one route from being a way to make the process allocate: 64 KB of JSON is already
  // far more than any card the browser half sends.
  const huge = JSON.stringify({ padding: 'x'.repeat(70 * 1024) })
  const captured = await answer(route, 'POST', '/__pocket/adopt', SAME_ORIGIN, huge)

  assert.equal(captured.status, 400, 'an oversized body is a client error')
  assert.match(JSON.parse(captured.body).error, /too large/, 'and says so: ' + captured.body)
})

test('a body that is not JSON is refused as the caller\'s mistake', async () => {
  const { route } = await scaffold()
  const captured = await answer(route, 'POST', '/__pocket/adopt', SAME_ORIGIN, 'not json at all')

  assert.equal(captured.status, 400, 'a malformed body is a client error')
  // 400 rather than 500 is the point: reporting the caller's mistake as a server fault tells a reader
  // the plugin broke when it did not, and buries a real fault among ordinary errors.
  assert.match(JSON.parse(captured.body).error, /not JSON/)
})

test('a method the route does not serve is refused as such', async () => {
  const { route } = await scaffold()
  const captured = await answer(route, 'PUT', '/__pocket/state', SAME_ORIGIN)

  assert.equal(captured.status, 405, 'the method is named as the problem')
})

test('an unknown path under the prefix is a 404', async () => {
  const { route } = await scaffold()
  const captured = await answer(route, 'POST', '/__pocket/nonsense', SAME_ORIGIN, '{}')

  assert.equal(captured.status, 404, 'a path the route does not serve is not a server fault')
})
