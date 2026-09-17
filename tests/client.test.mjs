/**
 * The browser half: module-table load, settings card, and the desktop mirror.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sleep,
  bind,
} from './support/harness.mjs'

test('the browser half loads through the module loader and registers its card', async () => {
  // The browser half is hand-written in the client module system's factory
  // format, so it can be executed here against a stand-in shell: this is the
  // only way to check its shape without a browser.
  const FakeReact = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useState: (initial) => [initial, () => {}],
  }
  /**
   * The shell seeds a fixed module table and nothing else resolves in the page.
   * This mirrors what the installed shell seeds — React and the UI primitives —
   * so a request for any other package fails here the way it fails in a browser,
   * instead of being papered over by a stub the real page never provides. Which
   * package owns the store engine, for instance, has moved between releases.
   */
  const baseline = {
    react: FakeReact,
    '@deepseek-ai/dsh-client-ui-primitives': { IconChevronDownOutline14: () => null },
  }
  /**
   * Load the bundle behind one stand-in shell.
   * @param url - module URL to load, query included.
   * @returns the id, exports, and requested specifiers the loader captured.
   */
  const load = async (url) => {
    let loaded
    const requested = []
    const previous = globalThis.window
    globalThis.window = {
      __ModuleLoader__: {
        load({ id, factory }) {
          loaded = {
            id,
            exports: factory((specifier) => {
              requested.push(specifier)
              assert.ok(Object.hasOwn(baseline, specifier), `the card may only request shell-seeded modules, asked for ${specifier}`)
              return baseline[specifier]
            }),
          }
        },
      },
    }
    try {
      await import(url)
    } finally {
      globalThis.window = previous
    }
    return { ...loaded, requested }
  }

  const loaded = await load('../client.js?verify')
  assert.equal(loaded.id, 'dsh-pocket-console', 'the module-table row id is the package name')
  assert.deepEqual(loaded.exports.inject, ['slots', 'settingsScope'])
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.deepEqual(
    [...new Set(loaded.requested)].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react'],
    'the bundle requests only modules the shell seeds',
  )

  const base = { delaySeconds: 120, maxDetailChars: 1200, titlePrefix: 'DSH' }
  let section = { ...base }
  let user
  const scopeListeners = new Set()
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: section,
      base,
      user,
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe(listener) {
      scopeListeners.add(listener)
      return () => { scopeListeners.delete(listener) }
    },
    async set(field, value) {
      user = { ...(user ?? {}), [field]: value }
      section = { ...section, [field]: value }
      for (const listener of scopeListeners) listener()
    },
    async unset(field) {
      if (user !== undefined) {
        const next = { ...user }
        delete next[field]
        user = Object.keys(next).length === 0 ? undefined : next
      }
      section = { ...section, [field]: base[field] }
      for (const listener of scopeListeners) listener()
    },
  }
  /** Stand-in for the Session UI service the desktop mirror reads. */
  const panelListeners = new Set()
  const uiSession = {
    pendingInteractions: {
      getSnapshot: () => new Map(),
      subscribe(listener) {
        panelListeners.add(listener)
        return () => { panelListeners.delete(listener) }
      },
    },
  }

  /**
   * Apply one loaded browser half against a stand-in host context.
   * @param module - the loaded browser half.
   * @returns what the card registered and bound.
   */
  const applyTo = (module) => {
    const seen = { inject: [], register: [], bind: undefined, effects: [] }
    module.apply({
      settingsScope: { bind(spec) { seen.bind = spec; return scope } },
      // The Session UI is reached through `get` because the browser half stays
      // loadable without it; the mirror reads the pending interaction there.
      get: (name) => name === 'uiSession' ? uiSession : undefined,
      effect(factory) {
        const disposer = factory()
        seen.effects.push(disposer)
        return disposer
      },
      slots: {
        inject(name, contribute) {
          seen.inject.push(name)
          contribute()
        },
        register(options, Component) {
          seen.register.push({ options, Component })
        },
      },
    })
    return {
      ...seen,
      registered: seen.register.find(entry => entry.options.name === 'settings.plugin.item'),
    }
  }

  // The desktop mirror runs from the plugin body against the Host's state route,
  // so the page's fetch and the Session UI are stubbed before the plugin applies.
  const answered = []
  const pending = {
    questions: [{ id: 'a' }, { id: 'b' }],
    answer: async (answer) => { answered.push(answer) },
  }
  const phoneAnswer = { answers: [{ id: 'a', selected: ['a1'] }] }
  const reports = []
  let served = { id: 'm1', sessionId: 's_agent', questions: ['a', 'b'], answer: phoneAnswer }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mirror')) {
      reports.push(JSON.parse(options.body))
      return { ok: true, json: async () => ({}) }
    }
    return { ok: true, json: async () => ({ sync: served }) }
  }
  uiSession.pendingInteractions.getSnapshot = () => new Map([['s_agent', pending]])

  const first = applyTo(loaded.exports)
  assert.deepEqual(first.inject, ['settings.plugin.item'])
  assert.deepEqual(first.bind, { namespace: 'pocket-console' }, 'the card binds its own settings namespace')
  assert.equal(first.registered.options.key, 'pocket-console', 'the card is keyed by the settings namespace')
  assert.equal(typeof first.registered.Component, 'function')

  const face = first.registered.options.inject()
  assert.equal(typeof face.copy.title, 'string')
  assert.equal(typeof face.edit, 'function')
  assert.equal(typeof face.resetField, 'function')
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.discard, 'function')
  assert.equal(typeof face.hooks.pocketConsole.getSnapshot, 'function', 'form state rides the hooks compartment')

  // The card edits its own namespace: it stages what the user types, writes on
  // save, and shows whether the user layer carries a field.
  const card = face.hooks.pocketConsole
  assert.equal(card.getSnapshot().shell.dirty, false)
  assert.deepEqual(card.getSnapshot().delaySeconds, { text: '120', overridden: false, invalid: false })

  face.edit('delaySeconds', '300')
  assert.equal(card.getSnapshot().shell.dirty, true, 'an edit stages instead of writing')
  assert.equal(section.delaySeconds, 120, 'nothing reaches the document before a save')

  await face.save()
  assert.equal(section.delaySeconds, 300, 'a save writes the staged value')
  assert.equal(card.getSnapshot().shell.dirty, false)
  assert.equal(card.getSnapshot().delaySeconds.overridden, true, 'the field now carries a user-layer entry')

  face.edit('delaySeconds', '不是数字')
  assert.equal(card.getSnapshot().delaySeconds.invalid, true, 'a draft the field cannot accept blocks the save')
  await face.save()
  assert.equal(section.delaySeconds, 300, 'an invalid draft writes nothing')

  face.resetField('delaySeconds')
  await face.save()
  assert.equal(section.delaySeconds, 120, 'a reset re-inherits the composition layer')
  assert.equal(card.getSnapshot().delaySeconds.overridden, false)

  // The mirror applies a phone decision through the same client call a click
  // makes, and reports each attempt to the Host, so a mirror that is not landing
  // says which step it reached.
  await sleep(50)
  assert.deepEqual(answered, [phoneAnswer], 'the phone decision reaches the waiting composer')
  assert.deepEqual(reports[0], { status: 'loaded' }, 'the bundle says it reached the page')
  assert.ok(reports.some(entry => entry.status === 'watching'))
  assert.ok(reports.some(entry => entry.status === 'applied' && entry.syncId === 'm1'))

  // A decision for a request this page is not showing is reported, not guessed at.
  served = { id: 'm2', sessionId: 's_agent', questions: ['x'], answer: phoneAnswer }
  await sleep(1100)
  assert.equal(answered.length, 1, 'a different request is left alone')
  assert.ok(reports.some(entry => entry.status === 'skipped' && entry.reason === 'no waiting composer'))

  // A page whose Session UI is absent says so instead of failing silently.
  uiSession.pendingInteractions.getSnapshot = () => undefined
  served = { id: 'm3', sessionId: 's_agent', questions: ['a', 'b'], answer: phoneAnswer }
  await sleep(1100)
  assert.ok(reports.some(entry => entry.status === 'skipped' && entry.reason === 'no pending-interaction source'))

  // Whether a composer is on screen is only observable in the page, so the
  // browser half reports the panel's own transitions: one shows, then it closes.
  assert.ok(
    reports.some(entry => entry.status === 'panel-open'),
    `a showing panel is reported: ${JSON.stringify(reports)}`,
  )
  assert.ok(panelListeners.size >= 1, 'the panel source is subscribed')
  uiSession.pendingInteractions.getSnapshot = () => new Map()
  for (const listener of panelListeners) listener()
  await sleep(20)
  assert.ok(
    reports.some(entry => entry.status === 'panel-closed'),
    `a closing panel is reported: ${JSON.stringify(reports)}`,
  )

  // Disposal stops the mirror: the plugin's effect owns the poll.
  assert.equal(first.effects.length, 1)
  first.effects[0]()
  assert.equal(panelListeners.size, 0, 'disposal also releases the panel source')
  served = { id: 'm4', sessionId: 's_agent', questions: ['a', 'b'], answer: phoneAnswer }
  await sleep(1100)
  assert.equal(
    reports.filter(entry => entry.syncId === 'm4').length,
    0,
    `a disposed mirror stops looking: ${JSON.stringify(reports)}`,
  )
  globalThis.fetch = previousFetch

  // The shell publishes the active language on <html>; the card follows it.
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  try {
    const chinese = await load('../client.js?verify-zh')
    const localized = applyTo(chinese.exports)
    assert.equal(localized.registered.options.inject().copy.title, '口袋控制台')
    // This apply exists for its copy alone; its own mirror must not outlive it.
    localized.effects[0]()
  } finally {
    delete globalThis.document
  }
})

