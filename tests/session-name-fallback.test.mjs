/**
 * A session that already had a name renders it too — the case a restart used to lose.
 *
 * The plugin learns names from the firehose's `session/title` events, and an event is only appended
 * when a session gets its first fallback title, when a generator finishes, or when somebody renames
 * it. None of those happens again for a session that already existed, so before this the small line
 * was silently missing from **every** existing session's cards — for the whole life of the deployment
 * (`session/title` events are not replayed at startup).
 *
 * What is asserted here is the fallback: a session whose title this process never heard an event for
 * still renders it, read once from the harness's own title service. The two orderings matter as much
 * as the reading, so both are cases: an event that arrives later must win, and the read must not
 * happen again once something is remembered.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { CARD_TEXT_BUDGET } from '../budget.js'
import { createSessionNames } from '../session-names.js'
import { messagesFor } from '../messages.js'

/** A copy table, so the line is spelled the way a card spells it. */
const copy = messagesFor('zh')

/** A session object the way the registry hands one over: with its own id. */
const sessionOf = (id) => ({ session: { id, header: { cwd: '/work/my-app' } } })

/**
 * Build the registry over a fake deployment.
 * @param options - `titles` is what the title service answers, by session id; `agents` what the
 *   registry holds; `withService` omits the service entirely when false.
 * @returns the registry, what it said out loud, and how many times the service was read.
 */
function names({ titles = {}, agents = {}, withService = true } = {}) {
  const said = []
  const reads = []
  const ctx = {
    get: (name) => {
      if (name === 'agents') {
        return {
          get: (id) => (agents[id] === undefined ? undefined : { session: sessionOf(id).session }),
        }
      }
      if (name === 'sessionTitle' && withService) {
        return {
          get: (session) => {
            reads.push(session?.id)
            const title = titles[session?.id]
            return title === undefined ? undefined : { title }
          },
        }
      }
      return undefined
    },
  }
  return {
    registry: createSessionNames({ ctx, messages: () => copy, diagnostics: (line) => said.push(line) }),
    said,
    reads,
  }
}

test('a session whose title event was never seen still names its cards', () => {
  const { registry, said } = names({
    titles: { s_old: '新会话任务与手机接管' },
    agents: { s_old: {} },
  })

  assert.equal(
    registry.subtitle('s_old'),
    `会话：新会话任务与手机接管`,
    'the name is read from the harness and rendered',
  )
  assert.equal(registry.tracked(), 1, 'and remembered, so the next card does not read again')
  assert.deepEqual(
    said,
    ['会话名：s_old → 新会话任务与手机接管'],
    'and it says where the name came from',
  )
})

test('the read happens once, not on every render', () => {
  const { registry, reads } = names({ titles: { s_old: '名字' }, agents: { s_old: {} } })
  registry.subtitle('s_old')
  registry.subtitle('s_old')
  registry.subtitle('s_old')
  assert.deepEqual(reads, ['s_old'], 'one read for the session, however many cards ask')
})

test('an event that arrives later wins over what was read', () => {
  const { registry } = names({ titles: { s_old: '旧名字' }, agents: { s_old: {} } })
  assert.match(registry.subtitle('s_old'), /旧名字/, 'the folded title is used first')
  registry.observe({ id: 's_old' }, { type: 'session/title', data: { title: '新名字' } })
  assert.match(registry.subtitle('s_old'), /新名字/, 'a rename on the firehose supersedes it')
})

test('a session with no title anywhere gets no line, and nothing is read twice', () => {
  const { registry, reads, said } = names({ agents: { s_bare: {} } })
  assert.equal(registry.subtitle('s_bare'), undefined, 'no title means no small line')
  assert.equal(registry.tracked(), 0, 'and nothing is remembered')
  assert.deepEqual(said, [], 'and nothing is claimed')
  assert.deepEqual(reads, ['s_bare'], 'the service was asked, once, and had nothing')
})

test('a deployment without the title service renders exactly as before', () => {
  // The property the feature has to keep: the service is optional, and its absence is not a failure.
  const { registry } = names({ titles: { s_old: '名字' }, agents: { s_old: {} }, withService: false })
  assert.equal(registry.subtitle('s_old'), undefined, 'no service, no name')
})

test('a session with no live agent is not read from', () => {
  const { registry, reads } = names({ titles: { s_gone: '名字' }, agents: {} })
  assert.equal(registry.subtitle('s_gone'), undefined, 'nothing to read the title from')
  assert.deepEqual(reads, [], 'and the service is not asked at all')
})

test('a title that is not one line is normalized the same way either source', () => {
  const { registry } = names({ titles: { s_old: '  两行\n名字  ' }, agents: { s_old: {} } })
  assert.equal(registry.subtitle('s_old'), '会话：两行 名字')
})

test('the read is bounded like everything else in the registry', () => {
  const agents = {}
  const titles = {}
  for (let index = 0; index < 300; index += 1) {
    agents[`s_${index}`] = {}
    titles[`s_${index}`] = `名字 ${index}`
  }
  const { registry } = names({ titles, agents })
  for (let index = 0; index < 300; index += 1) registry.subtitle(`s_${index}`)
  assert.ok(registry.tracked() <= 256, `the registry stays bounded: ${registry.tracked()}`)
  assert.ok(CARD_TEXT_BUDGET > 0, 'and the budget this card is held to is a real number')
})
