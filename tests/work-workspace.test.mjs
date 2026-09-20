/**
 * Where a phone-started session lands on the desk.
 *
 * A session is grouped in the Web interface because a workspace's ordered account names it, and that
 * account is written only when creation names a workspace. `sessionController.create` attaches the
 * session *solely* on its `workspaceId` branch and treats `cwd` as the fallback for a session that
 * belongs to no group — so a task started from the phone used to run correctly, reach the phone
 * correctly, and sit under "ungrouped" at the desk. Reported from a real deployment and reproduced in
 * its stored data: a session whose header cwd was a registered workspace and whose id was in no
 * workspace's account.
 *
 * What a case here can assert is the **request**, because that is the whole of the fix: resolution
 * names a workspace, the workspace is what creation receives, and the two are never both sent
 * (`create` refuses `workspaceId` together with `cwd` as a bad request). What it cannot assert is the
 * desk actually grouping the result — that needs the real registry and the real Web interface, and it
 * is in `internal/verification-checklist.md`.
 *
 * Driven directly rather than through the plugin, because the request is not visible from outside:
 * the scaffold's controller records what it was asked for, but not the branch that chose it.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createWork, WORK_START, WORK_FIELD } from '../work.js'

/** The directory the asking session works in, which is what a new task inherits. */
const CWD = 'C:\\work\\my-app'

/** The workspace the registry reports for that directory. */
const WORKSPACE_ID = 'ws-1'

/** The plugin's copy, minimal: these cases are about routing, not wording. */
const COPY = {
  workIntro: 'intro',
  workOfferHint: '--- hint',
  workPlaceholder: 'placeholder',
  workStart: 'start',
  workStarted: workspace => `started ${workspace ?? ''}`,
  workAlreadyStarted: 'already',
  noSessionController: 'no controller',
  emptyInstruction: 'empty',
  sent: 'sent',
  logWorkStarted: () => 'started',
  logWorkFailed: 'failed',
  logWorkUnowned: () => 'unowned',
  logWorkUngrouped: 'ungrouped',
}

/**
 * A deployment with one asking session, driven directly.
 * @param options - how the workspace registry and the controller behave; `askedCwd` replaces the
 *   asking session's directory, which is how a case makes its workspace unresolvable.
 * @returns the work module, what the controller was asked for, and what it was told afterwards.
 */
function build({ resolve, create, askedCwd = CWD } = {}) {
  /** Every request handed to `sessionController.create`, in order. */
  const requests = []
  /** Every message handed to a created session, in order. */
  const followed = []
  /** Every warning the module logged. */
  const warnings = []
  let created = 0

  const asked = { status: 'idle', session: { header: { cwd: askedCwd } } }
  const agents = {
    get: (id) => {
      if (id === 'asked') return asked
      const agent = createdSessions.get(id)
      return agent
    },
    list: () => [],
  }
  // Filled as sessions are created, so `prompt` finds the new session's agent.
  const createdSessions = new Map()

  const controller = {
    async create(request) {
      requests.push(request)
      if (create !== undefined && await create(request) === 'refuse') {
        throw new Error('session/workspace-attach-failed')
      }
      created += 1
      const id = `new-${created}`
      // A session that exists has a live agent: that is what the plugin hands the prompt to, and
      // registering it here is what lets a case assert the prompt landed exactly once.
      const agent = { status: 'idle', followed, followup: (message) => { followed.push(message) } }
      createdSessions.set(id, agent)
      agents.get = (askedId) => (askedId === 'asked' ? asked : createdSessions.get(askedId))
      return { sessionId: id }
    },
  }

  const registry = resolve === undefined
    ? undefined
    : {
      async resolveByPath(path) {
        assert.equal(path, askedCwd, 'resolution is asked about the directory the session inherited')
        return await resolve()
      },
    }

  const ctx = {
    get: (name) => {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return registry
      return agents
    },
  }

  const work = createWork({
    ctx,
    log: { warn: (...args) => warnings.push(args), info: () => {}, debug: () => {} },
    channel: { deliver: async () => 'om_1', update: async () => {} },
    settings: () => ({ titlePrefix: 'DSH' }),
    messages: () => COPY,
    workspaces: { record: () => {}, sessionOf: () => 'asked' },
    priority: { get: () => 'phone', set: () => {} },
  })

  /** Press the offer the way a channel reports it. */
  const press = async (text = '做点什么') => await work.handleAction({
    payload: { work: WORK_START, submits: { [WORK_FIELD]: 'form_1_workText' } },
    values: { form_1_workText: text },
    messageId: 'om_1',
  })

  return { press, requests, followed, warnings, work }
}

test('merging the offer never rewrites the card\'s title', async () => {
  // The card's title names the workspace once, when the card is built, and a rewrite inherits it.
  // This module used to recompute it from the session, which *re-read* the session for a label the
  // card already carried — and a session reclaimed in between names nothing, so the label would
  // vanish from the card at exactly the wrong moment. `identity.js` says never to re-read for a
  // rewrite; this is where that rule was broken.
  const { work } = build({ askedCwd: 'C:\\nowhere\\gone' })

  const merged = work.mergeInto({ title: 'DSH 结果 · my-app', body: ['answer'], forms: [] }, 'asked')
  assert.equal(merged.title, 'DSH 结果 · my-app', 'the title the caller built is the title that stays')

  // And the aftermath pass, which is handed the card as it was sent, does the same.
  const closed = work.mergeInto(merged, 'asked', '已开新会话')
  assert.equal(closed.title, 'DSH 结果 · my-app', 'and closing the offer does not touch it either')
})

test('a phone-started session is created through its workspace, not a bare directory', async () => {
  const { press, requests, followed } = build({
    resolve: async () => ({ id: WORKSPACE_ID, path: CWD }),
  })

  const toast = await press()
  assert.equal(toast.accepted, true, 'the press is accepted')
  assert.deepEqual(
    requests,
    [{ workspaceId: WORKSPACE_ID }],
    'creation names the workspace and nothing else: sending both is a bad request, and sending only '
    + 'the directory is what left the session ungrouped',
  )
  assert.equal(followed.length, 1, 'and the task was handed to the new session')
  assert.equal(followed[0].content[0].text, '做点什么')
  assert.deepEqual(
    followed[0].source,
    { kind: 'user' },
    'human input, and with no gateway request id — which would read as somebody at the desk',
  )
})

test('a directory no workspace owns is created by directory, and the log says why', async () => {
  const { press, requests, warnings } = build({ resolve: async () => undefined })

  await press()
  assert.deepEqual(requests, [{ cwd: CWD }], 'the session still starts, in the directory it inherited')
  assert.equal(warnings.length, 1, 'the reader of the log is told once: ' + JSON.stringify(warnings))
  // The copy is the deployment's language, so the case names its key rather than its wording.
  assert.deepEqual(warnings[0], ['unowned'], 'through the line that says the directory has no owner')
})

test('a registry that refuses still starts the task, ungrouped', async () => {
  const { press, requests, warnings } = build({
    resolve: async () => { throw new Error('the directory does not resolve') },
  })

  const toast = await press()
  assert.equal(toast.accepted, true, 'the press is still accepted')
  assert.deepEqual(requests, [{ cwd: CWD }], 'creation falls back to the directory')
  assert.deepEqual(warnings[0]?.[0], 'ungrouped', 'and the fallback is reported rather than swallowed')
})

test('a creation that fails is retried by directory, and prompts exactly once', async () => {
  // `create` attaches the session *after* it exists, so this is the branch that keeps a failure from
  // leaving a card that says "已开新会话" with nothing behind it.
  let attempt = 0
  const { press, requests, followed } = build({
    resolve: async () => ({ id: WORKSPACE_ID, path: CWD }),
    // Only the workspace branch fails; the fallback must be the one that gets the prompt.
    create: async () => { attempt += 1; return attempt === 1 ? 'refuse' : 'accept' },
  })

  const toast = await press()
  assert.equal(toast.accepted, true, 'the task still starts')
  assert.deepEqual(
    requests,
    [{ workspaceId: WORKSPACE_ID }, { cwd: CWD }],
    'the workspace is tried first and the directory second',
  )
  assert.equal(followed.length, 1, 'and exactly one prompt was handed over, not none or two')
})

test('a deployment with no workspace registry keeps working, by directory', async () => {
  const { press, requests } = build({})
  await press()
  assert.deepEqual(requests, [{ cwd: CWD }], 'the optional service is optional')
})

test('no session controller is reported, and nothing is created', async () => {
  const work = createWork({
    ctx: { get: (name) => (name === 'agents' ? { get: () => ({ session: { header: { cwd: CWD } } }) } : undefined) },
    log: { warn: () => {}, info: () => {}, debug: () => {} },
    channel: { deliver: async () => 'om_1' },
    settings: () => ({ titlePrefix: 'DSH' }),
    messages: () => COPY,
    workspaces: { sessionOf: () => 'asked' },
    priority: { get: () => 'phone', set: () => {} },
  })
  const toast = await work.handleAction({
    payload: { work: WORK_START, submits: { [WORK_FIELD]: 'f' } },
    values: { f: 'text' },
    messageId: 'om_1',
  })
  assert.equal(toast.accepted, false, 'the press is refused with a reason')
  assert.match(toast.toast, /no controller/)
})
