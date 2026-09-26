/**
 * The third control on an approval card: "do not ask again", which is a permission switch and not a
 * grant this plugin is allowed to invent.
 *
 * DSH's approval vocabulary is closed (`allowed-once` is the only grant, and there is no remembered
 * rule or grant store), so "stop asking" cannot be an answer to a request — it is a change of
 * **policy**, and the policy belongs to DSH. `ctx.permissionPresets` is where that lives: one preset
 * bundles a sandbox mode with an approval policy, and the shipped table's `danger-full-access` is
 * exactly "no confinement, and never ask". Switching a session to it writes `permission/preset` +
 * `sandbox/mode` + `approval/policy`, three durable events that say a person chose this.
 *
 * The alternative — answering every request with `allowed-once` — is what this file exists to prevent:
 * `approval/decided` carries `{ id, outcome }` and no actor, so the log would say a human decided.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createPermissions } from '../permissions.js'
import { createEscalation } from '../escalation.js'

/** Copy for a case that is not about language. */
const COPY = {
  approvalTitle: 'Tool approval', questionTitle: 'Question',
  questionOf: (position, total) => `Question ${position} of ${total}`,
  toolLabel: tool => `**Tool**: ${tool}`, callIdLabel: id => `**Call id**: ${id}`,
  reasonLabel: reason => `**Reason**: ${reason}`,
  approvalLive: 'live', approvalUpgraded: seconds => `upgraded after ${seconds}s`,
  allowOnce: 'Allow once', reject: 'Reject', optionsLegend: '**Options**',
  progress: (answered, total) => `${answered}/${total}`, selectionSeparator: ', ',
  answerSeparator: '; ', submitAnswer: 'Submit', submitOther: 'Other',
  allowedOnce: 'Allowed', rejected: 'Rejected', cancelled: 'Cancelled',
  answeredAtDesk: 'Answered at the desk', recorded: (a, t) => `${a}/${t}`,
  answered: summary => `Answered: ${summary}`, answersSubmitted: 'Submitted',
  requestGone: 'Gone', requestGoneTitle: 'Ended', actionUnknown: 'Unknown', truncated: '…',
  logMessageRewriteFailed: 'rewrite failed', logDeliveryFailed: 'delivery failed',
  logCardTooLarge: 'card too large', logMirror: status => status,
  logDeliveryRetrying: () => 'retrying', logDeliveryGivenUp: () => 'gave up',
  logStalePress: 'stale press', logRewriteAttempts: () => '',
  allowFullAccess: label => `Do not ask again (${label})`,
  fullAccessConfirmTitle: 'Switch to full access?', fullAccessConfirmText: 'this path goes quiet',
  fullAccessSettled: label => `Switched to ${label}`,
  fullAccessOn: label => `switched to ${label}`,
  fullAccessUnavailable: 'no preset to switch to', fullAccessFailed: 'the switch did not happen',
  logFullAccessFailed: 'presets failed',
}

/**
 * A host whose permission presets are whatever a case says they are.
 * @param options - the preset table and how the switch behaves.
 * @returns the adapter and the record of what it did.
 */
function host({ presets, switchThrows = false, catalogThrows = false, reads = 'workspace-write' } = {}) {
  const calls = { set: [], current: 0 }
  const table = presets ?? [
    { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
    { value: 'yolo', sandbox: 'danger-full-access', approval: 'never' },
  ]
  const service = {
    catalog() {
      if (catalogThrows) throw new Error('no projection')
      return {
        options: table.map(entry => ({ value: entry.value, name: entry.name ?? entry.value, description: entry.description })),
        defaultOptions: [], defaultPreset: table[0].value,
      }
    },
    resolve(name) {
      const entry = table.find(item => item.value === name)
      if (entry === undefined) throw new Error('unknown preset')
      return { sandbox: entry.sandbox, approval: entry.approval, name: entry.name, description: entry.description }
    },
    current() { calls.current += 1; return reads },
    set(session, name) {
      if (switchThrows) throw new Error('refused')
      calls.set.push({ session, name })
    },
  }
  const permissions = createPermissions({
    ctx: { get: (name) => (name === 'permissionPresets' ? service : undefined) },
    log: { warn() {} },
    messages: () => COPY,
  })
  return { permissions, calls, table, service }
}

test('the full-access preset is found by its bundle, not by its name', () => {
  const { permissions } = host()
  // A deployment is free to rename it; what makes it full access is the knobs it writes.
  assert.deepEqual(permissions.fullAccess(), { name: 'yolo', label: 'yolo' })
})

test('a deployment may label its presets, and the label is what the card uses', () => {
  const { permissions } = host({
    presets: [
      { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
      { value: 'full', sandbox: 'danger-full-access', approval: 'never', name: '完全权限' },
    ],
  })
  assert.deepEqual(permissions.fullAccess(), { name: 'full', label: '完全权限' })
})

test('a table without such a preset offers no switch, rather than a switch to something else', () => {
  const { permissions } = host({
    presets: [
      { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
      // Full access *sandbox* with `ask` approval is the experimental review preset: it still asks,
      // so it is not what "do not ask again" means and must not be offered as it.
      { value: 'auto', sandbox: 'danger-full-access', approval: 'ask' },
    ],
  })
  assert.equal(permissions.fullAccess(), undefined)
})

test('a host with no permission service at all is not an error', () => {
  const permissions = createPermissions({ ctx: { get: () => undefined }, log: { warn() {} }, messages: () => COPY })
  assert.equal(permissions.fullAccess(), undefined)
  assert.equal(permissions.current({}), undefined)
  assert.equal(permissions.set({}, 'anything'), false)
})

test('a switch that the service refuses is reported as not switched', () => {
  const refused = host({ switchThrows: true })
  assert.equal(refused.permissions.set({ id: 's' }, 'yolo'), false)
  const broken = host({ catalogThrows: true })
  assert.equal(broken.permissions.fullAccess(), undefined, 'a catalog that cannot be read offers nothing')
})

test('the adapter switches one session and reads one session', () => {
  const { permissions, calls } = host()
  const session = { id: 's_1' }
  assert.equal(permissions.set(session, 'yolo'), true)
  assert.deepEqual(calls.set, [{ session, name: 'yolo' }])
  assert.equal(permissions.current(session), 'workspace-write')
})

/** A channel that records what the escalation asked of it. */
function stubChannel() {
  const delivered = []
  return {
    delivered,
    channel: {
      supportsForms: true,
      available: () => true,
      async deliver(view) { delivered.push(view); return { id: `handle_${delivered.length}` } },
      async update() {},
      subscribe() { return () => {} },
      close() {},
    },
  }
}

/** An escalation over one stub channel, with the given permission adapter. */
function machine(channel, permissions) {
  return createEscalation({
    log: { warn() {}, info() {}, debug() {} },
    channel,
    settings: () => ({ delaySeconds: 0, titlePrefix: 'DSH' }),
    mirror: { record() {}, report() {}, state: () => ({ sync: null, mirror: [] }) },
    messages: () => COPY,
    permissions,
  })
}

/** One approval request, as the waterfall hands it over. */
const request = () => ({
  toolName: 'pwsh',
  agent: { status: 'idle', session: { id: 's_1', header: { cwd: '/work/my-app' } } },
  reason: 'it writes outside the workspace',
  signal: new AbortController().signal,
})

test('the approval card gains a third control when the deployment offers full access', async () => {
  const { channel, delivered } = stubChannel()
  const { permissions } = host()
  const escalation = machine(channel, permissions)
  const desktop = Promise.withResolvers()
  void escalation.escalate(request(), () => desktop.promise, 'approval')
  await new Promise(resolve => setTimeout(resolve, 30))

  const buttons = delivered[0].buttons
  assert.equal(buttons.length, 3, 'allow once, reject, and do not ask again')
  const full = buttons.find(button => button.payload.v === 'allowed-full')
  assert.equal(full.label, 'Do not ask again (yolo)', 'and the deployment names the preset')
  assert.equal(full.tone, 'default', 'the privilege change is not the most inviting control on the card')
  assert.deepEqual(full.confirm, { title: 'Switch to full access?', text: 'this path goes quiet' },
    'and it asks before it acts, which is the step a plugin would otherwise step over')
  desktop.resolve('allowed-once')
})

test('without a full-access preset the card has the two controls it has always had', async () => {
  const { channel, delivered } = stubChannel()
  const { permissions } = host({ presets: [{ value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }] })
  const escalation = machine(channel, permissions)
  const desktop = Promise.withResolvers()
  void escalation.escalate(request(), () => desktop.promise, 'approval')
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(delivered[0].buttons.length, 2, 'no button that could not do what it says')
  desktop.resolve('allowed-once')
})

test('pressing it switches the session and grants the request being looked at', async () => {
  const { channel, delivered } = stubChannel()
  const { permissions, calls } = host()
  const escalation = machine(channel, permissions)
  const desktop = Promise.withResolvers()
  const decided = escalation.escalate(request(), () => desktop.promise, 'approval')
  await new Promise(resolve => setTimeout(resolve, 30))

  const full = delivered[0].buttons.find(button => button.payload.v === 'allowed-full')
  const answer = escalation.handleAction({ payload: full.payload, messageId: 'om_card' })

  assert.equal(calls.set.length, 1, 'the policy was switched exactly once')
  assert.equal(calls.set[0].name, 'yolo', 'to the full-access preset')
  assert.equal(calls.set[0].session.id, 's_1', 'for the session the request came from')
  assert.equal(answer.accepted, true)
  assert.equal(answer.toast, 'switched to yolo')
  // The person pressing "do not ask again" wants this one to go through, so it is granted — and the
  // settlement is a one-shot grant, which is the only thing DSH's vocabulary can express.
  assert.equal(await decided, 'allowed-once', 'and this request was granted, not left hanging')
})

test('a switch that did not happen settles nothing', async () => {
  const { channel, delivered } = stubChannel()
  const { permissions } = host({ switchThrows: true })
  const escalation = machine(channel, permissions)
  const desktop = Promise.withResolvers()
  const decided = escalation.escalate(request(), () => desktop.promise, 'approval')
  await new Promise(resolve => setTimeout(resolve, 30))
  decided.catch(() => {})

  const full = delivered[0].buttons.find(button => button.payload.v === 'allowed-full')
  const answer = escalation.handleAction({ payload: full.payload, messageId: 'om_card' })
  assert.equal(answer.accepted, false, 'the press did not decide anything')
  assert.equal(answer.toast, 'the switch did not happen')

  // And the request is still open, so the ordinary answers still work — which is the point of failing
  // closed rather than half-settling it.
  const allow = delivered[0].buttons.find(button => button.payload.v === 'allowed-once')
  escalation.handleAction({ payload: allow.payload, messageId: 'om_card' })
  assert.equal(await decided, 'allowed-once', 'the card is still answerable the ordinary way')
})

test('a question card never grows a permission control', async () => {
  const { channel, delivered } = stubChannel()
  const { permissions } = host()
  const escalation = machine(channel, permissions)
  const desktop = Promise.withResolvers()
  void escalation.escalate({
    agent: { status: 'idle', session: { id: 's_1', header: { cwd: '/work/my-app' } } },
    questions: [{ id: 'q1', question: 'which one?', options: [{ label: 'a', value: 'a' }] }],
    signal: new AbortController().signal,
  }, () => desktop.promise, 'question')
  await new Promise(resolve => setTimeout(resolve, 30))

  const controls = [...delivered[0].buttons, ...delivered[0].forms]
  assert.equal(controls.some(control => control.payload?.v === 'allowed-full'), false,
    'a question is not a place where a permission policy is decided')
  desktop.resolve('cancelled')
})
