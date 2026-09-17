/**
 * The browser half: module-table load, settings card, and the desktop mirror.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  sleep,
  bind,
} from './support/harness.mjs'

test('the browser half loads through the module loader and registers its card', async () => {
  // The browser half is hand-written in the client module system's factory
  // format, so it can be executed here against a stand-in shell: this is the
  // only way to check its shape without a browser.
  const FakeReact = {
    // Trees instead of nulls: a case has to read what the card renders, not only
    // that it registered. Element identity is all this needs — no DOM.
    createElement: (type, props, ...children) => ({
      type,
      props: {
        ...(props ?? {}),
        children: children.flat().filter(child => child !== null && child !== undefined && child !== false),
      },
    }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    // Real state cells in call order, so a case can press the card's header to
    // open the disclosure and render again, the way a person does.
    useState: (initial) => {
      const index = FakeReact.cursor
      FakeReact.cursor += 1
      // React calls a function initializer instead of storing it; a stand-in that
      // stored the function would hand the component a value it never renders,
      // which is how a card reading its language from state came out undefined.
      if (!(index in FakeReact.cells)) {
        FakeReact.cells[index] = typeof initial === 'function' ? initial() : initial
      }
      return [FakeReact.cells[index], (next) => {
        FakeReact.cells[index] = typeof next === 'function' ? next(FakeReact.cells[index]) : next
      }]
    },
    cells: [],
    cursor: 0,
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
    '@deepseek-ai/dsh-client-ui-primitives': {
      IconChevronDownOutline14: () => null,
      // The platform's dialog, as a findable node: the card must open this one
      // instead of the browser's confirm(). A string type keeps the element
      // inspectable without rendering anything.
      Modal: 'Modal',
    },
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

  const base = { delaySeconds: 120, maxDetailChars: 1200, titlePrefix: 'DSH', resultNotify: 'idle' }
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
  assert.equal(typeof face.edit, 'function')
  assert.equal(typeof face.resetField, 'function')
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.discard, 'function')
  assert.equal(typeof face.hooks.pocketConsole.getSnapshot, 'function', 'form state rides the hooks compartment')

  /**
   * Render one apply's card and hand back everything it put on screen.
   *
   * The card resolves its own copy from the page's language and watches that
   * attribute, so its text is asserted by rendering it rather than by reading a
   * prop — which is also the only way to prove the language it reports is the
   * language it rendered in.
   * @param applied - one `applyTo` result.
   * @returns the card's face, its store, and the collector for one render.
   */
  const renderFor = (applied) => {
    const own = applied.registered.options.inject()
    const ownStore = own.hooks.pocketConsole
    return {
      face: own,
      store: ownStore,
      render: () => {
        // Cells belong to one mounted card: this stand-in has no React to key
        // them by component, so a second apply would otherwise inherit the first
        // one's state — including the language it read at mount.
        FakeReact.cells = []
        FakeReact.cursor = 0
        return applied.registered.Component({
          ...own,
          usePocketConsole: selector => selector(ownStore.getSnapshot()),
        })
      },
    }
  }

  /** Every string the card renders, in tree order. */
  const textOf = (tree) => {
    const found = []
    const walk = (node) => {
      if (typeof node === 'string') { found.push(node); return }
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      walk(node.props?.children)
    }
    walk(tree)
    return found
  }

  assert.ok(
    textOf(renderFor(first).render()).includes('Pocket console'),
    'the card renders its own name, resolved from the page language',
  )

  // Both dictionaries carry the same keys, and every one is a string or a
  // formatter. A key added to one language only would surface as `undefined`
  // rendered into the card — the failure a second locale exists to prevent.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const dictionaries = ['zh', 'en'].map((locale) => {
    const start = source.indexOf(`      ${locale}: {`)
    assert.notEqual(start, -1, `client.js carries a ${locale} dictionary`)
    const end = source.indexOf('\n      },', start)
    return {
      locale,
      keys: [...source.slice(start, end).matchAll(/^        ([A-Za-z][\w]*):/gm)].map(match => match[1]),
    }
  })
  const [zh, en] = dictionaries
  assert.ok(zh.keys.length > 40, `the card's copy is not empty (${zh.keys.length} keys)`)
  assert.deepEqual(
    zh.keys.filter(key => !en.keys.includes(key)),
    [],
    'every Chinese key has an English counterpart',
  )
  assert.deepEqual(
    en.keys.filter(key => !zh.keys.includes(key)),
    [],
    'every English key has a Chinese counterpart',
  )

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
  // The report always names the language, even when the page names none: the value
  // sent is the one the card itself rendered in, so it can never disagree with the
  // card, and the Host never has to guess with its own configured `locale`.
  assert.deepEqual(reports[0], { status: 'loaded', lang: 'en' }, 'the bundle says it reached the page')
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

  // One entry per session, so a second session's panel is its own transition even
  // while the first is still showing — which is what a plain open/closed flag hid.
  uiSession.pendingInteractions.getSnapshot = () => new Map([
    ['session-1111', { kind: 'question' }],
    ['session-2222', { kind: 'question' }],
  ])
  for (const listener of panelListeners) listener()
  await sleep(20)
  const showing = reports.filter(entry => entry.status === 'panel-open').at(-1)
  assert.match(showing.reason, /question#1111/)
  assert.match(showing.reason, /question#2222/)

  uiSession.pendingInteractions.getSnapshot = () => new Map([['session-2222', { kind: 'question' }]])
  for (const listener of panelListeners) listener()
  await sleep(20)
  const remaining = reports.filter(entry => entry.status === 'panel-open').at(-1)
  assert.equal(remaining.reason, 'question#2222', 'the panel that stayed is the one named')

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

  // The shell publishes the active language on <html>; the card follows it. It is
  // asserted through the rendered tree, because reading the copy off a prop would
  // pass even while the card rendered something else.
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  try {
    const chinese = await load('../client.js?verify-zh')
    const localized = applyTo(chinese.exports)
    const zhRender = renderFor(localized)
    const zhText = textOf(zhRender.render())
    assert.ok(zhText.includes('口袋控制台'), `the card renders in the page's language: ${JSON.stringify(zhText.slice(0, 4))}`)
    // A language the copy has no table for still lands on one of the two.
    globalThis.document.documentElement.lang = 'fr'
    assert.ok(textOf(zhRender.render()).includes('Pocket console'), 'an unknown language falls back to English')
    // This apply exists for its copy alone; its own mirror must not outlive it.
    localized.effects[0]()
  } finally {
    delete globalThis.document
  }

  // Every rendered label belongs to its own control. A positional list paired a
  // label with whichever field sat at that index, so inserting one in the middle
  // showed one field's value under another field's name.
  const renderedCard = applyTo(loaded.exports)
  const pairFace = renderedCard.registered.options.inject()
  const pairStore = pairFace.hooks.pocketConsole

  /** Render the card once, with the store bound the way the renderer binds it. */
  const renderCard = () => {
    FakeReact.cursor = 0
    return renderedCard.registered.Component({
      ...pairFace,
      usePocketConsole: selector => selector(pairStore.getSnapshot()),
    })
  }

  const collect = (tree) => {
    const labels = new Map()
    const controls = []
    const chevrons = []
    const dialogs = []
    const texts = []
    const walk = (node) => {
      // Text is collected before the object guard: a label is a string child, and
      // `typeof` sends it out of the walk otherwise.
      if (typeof node === 'string') {
        texts.push(node)
        return
      }
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      if (node.type === 'label') labels.set(node.props.htmlFor, node.props.children.join(''))
      if (node.type === 'input' || node.type === 'select') controls.push(node)
      if (node.type === 'span' && node.props.style?.display === 'inline-flex'
        && String(node.props.style.color ?? '').includes('label-tertiary')) {
        chevrons.push(node)
      }
      if (node.type === 'Modal') dialogs.push(node)
      if (typeof node === 'string') texts.push(node)
      walk(node.props?.children)
    }
    walk(tree)
    return { labels, controls, chevrons, dialogs, texts }
  }
  // The card is a disclosure: it starts collapsed, and opening it is the only way
  // its fields exist at all. The cells are seeded rather than inferred, because
  // this stand-in shares one cell table across every render in the case.
  FakeReact.cells = [false]
  const collapsed = collect(renderCard())
  assert.equal(collapsed.controls.length, 0, 'a collapsed card renders no controls')

  /** The card's disclosure header, wherever it sits in the tree. */
  const headerOf = (tree) => (function find(node) {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) return node.map(find).find(Boolean)
    if (node.type === 'button' && node.props['aria-expanded'] !== undefined) return node
    return find(node.props?.children)
  })(tree)
  /** Every node that announces a change on its own. */
  const liveRegionsOf = (tree) => {
    const found = []
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      if (node.props?.['aria-live'] !== undefined) found.push(node)
      walk(node.props?.children)
    }
    walk(tree)
    return found
  }

  // A reader who is not looking. A label replaces the button's text as its spoken
  // name, so a badge the label omits is a state nobody hears; and the enrollment
  // state moves on its own, so its row has to announce itself.
  const dirty = renderFor(renderedCard)
  dirty.face.edit('delaySeconds', '300')
  assert.match(
    String(headerOf(dirty.render()).props['aria-label']),
    new RegExp(dirty.face.copy.unsaved),
    "an unsaved card says so in the header's own accessible name",
  )
  dirty.face.discard()

  // The status row only exists once the card has a state to show, which is what
  // the seed provides; the live region is asserted on an open card that has one.
  FakeReact.cells[1] = { enrollment: { state: 'unbound' }, settings: {}, pending: [] }
  const stateHeader = headerOf(renderCard())
  assert.ok(stateHeader !== undefined, 'the card has a disclosure header')
  const live = liveRegionsOf(stateHeader.props.onClick() ?? renderCard())
  assert.ok(
    live.some(node => node.props.role === 'status' && String(node.props['aria-live']) === 'polite'),
    `the enrollment state is a polite live region, so a change announces itself: ${JSON.stringify(live.map(node => node.props))}`,
  )
  assert.ok(
    live.length >= 1 && live.every(node => node.props['aria-live'] !== 'assertive'),
    'and nothing on the card interrupts a reader mid-sentence',
  )

  // A positional list paired a label with whichever field sat at that index, so
  // inserting one in the middle showed one field's value under another field's
  // name. The store's projection and the card's rows are both derived from the one
  // FIELDS list, so the projection is asserted to carry exactly those fields.
  const projection = pairStore.getSnapshot()
  const projected = Object.keys(projection).filter(key => key !== 'shell')
  assert.ok(projected.length >= 3, `the store projects its fields: ${projected.join(', ')}`)
  assert.deepEqual(
    projected,
    ['delaySeconds', 'titlePrefix', 'resultNotify'],
    'the projection follows the FIELDS list the card renders from',
  )

  // The icon takes only size and className, so the wrapper owns colour and
  // rotation: without it the chevron kept the header's colour and never turned.
  // Opening the card is the only way its fields exist, so the same click that
  // opens it is what turns the chevron; both are read off the frame it produces.
  // The runtime seed is cleared first, so the frame holds exactly the card's own
  // fields — the per-state sections are asserted on their own below.
  FakeReact.cells[1] = null
  FakeReact.cells[0] = false
  const openHeaderOfFields = headerOf(renderCard())
  const openedTree = openHeaderOfFields.props.onClick() ?? renderCard()
  const { labels, controls, chevrons } = collect(openedTree)

  assert.ok(controls.length >= 3, `an open card renders its controls: ${controls.length}`)
  for (const control of controls) {
    const field = String(control.props.id).replace('pocket-console-', '')
    assert.ok(projection[field] !== undefined, `${field} is a projected field`)
    // A positional list paired a label with whichever field sat at that index,
    // so a mispairing showed one field's value under another field's name.
    assert.equal(control.props.value, projection[field].text, `${field} shows its own value`)
    assert.ok(labels.has(control.props.id), `${field} carries its own label`)
  }
  // Every field's label is distinct: a list rendered positionally would repeat one
  // field's name under another field.
  assert.equal(new Set([...labels.values()]).size, labels.size, 'no two fields share a label')

  assert.equal(chevrons.length, 1, 'the chevron is wrapped in its own element')
  assert.equal(chevrons[0].props.children.length, 1, 'and the icon sits inside it')
  assert.equal(
    chevrons[0].props.style.transform,
    'rotate(180deg)',
    'an open card points its chevron up, the way every other plugin card does',
  )

  // Binding is one decision with two answers; re-binding was a third button that
  // did what the first one does, because the channel reconnects on its own. The
  // binding row lives in the runtime section, so the card needs a state to show.
  FakeReact.cells[1] = { enrollment: { state: 'unbound' }, settings: {}, pending: [] }
  const unbound = collect(renderCard())
  assert.ok(unbound.texts.includes(pairFace.copy.bind), 'the card offers creating an app: ' + JSON.stringify(unbound.texts.slice(0, 12)))
  assert.ok(unbound.texts.includes(pairFace.copy.bindExisting), 'and binding one that already exists')
  assert.ok(!unbound.texts.includes(pairFace.copy.rebind ?? '重新绑定'), 're-binding is gone')
  assert.equal(unbound.dialogs.filter(dialog => dialog.props.open === true).length, 0, 'and nothing is modal yet')

  // Unbinding asks through the GUI's own dialog, not the browser's confirm().
  const boundRuntime = { enrollment: { state: 'bound', recipient: 'ou_scanner' }, settings: {}, pending: [] }
  FakeReact.cells[1] = boundRuntime
  const pressed = []
  const previousUnbindFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    pressed.push({ url: String(url), body: options?.body })
    return { ok: true, json: async () => ({ state: 'unbound' }) }
  }
  try {
    const boundCard = collect(renderCard())
    assert.ok(!boundCard.texts.includes(pairFace.copy.bindExisting), 'a bound card offers unbinding only')

    const unbindButton = (function find(node) {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(find).find(Boolean)
      if (node.type === 'button' && node.props.children?.[0] === pairFace.copy.unbind
        && node.props['aria-expanded'] === undefined) return node
      return find(node.props?.children)
    })(renderCard())
    assert.ok(unbindButton !== undefined, 'a bound card has an unbind control')

    unbindButton.props.onClick()
    const asking = collect(renderCard()).dialogs.filter(dialog => dialog.props.open === true)
    assert.equal(asking.length, 1, 'pressing it opens the platform dialog')
    assert.equal(asking[0].props.description, pairFace.copy.unbindConfirm)
    assert.equal(pressed.length, 0, 'and nothing is unbound until the dialog is confirmed')

    const confirm = asking[0].props.footer.find(node => node.props.children?.[0] === pairFace.copy.unbind)
    assert.ok(confirm !== undefined, 'the dialog carries the confirmation')
    confirm.props.onClick()
    await sleep(20)
    assert.ok(
      pressed.some(call => call.url.endsWith('/__pocket/unbind')),
      `confirming posts the unbind: ${JSON.stringify(pressed)}`,
    )

    // Binding an existing app asks which one: the launch page only learns the app
    // from the id it is carried with, so the card collects it first.
    FakeReact.cells[1] = { enrollment: { state: 'unbound' }, settings: {}, pending: [] }
    pressed.length = 0
    const bindExisting = (function find(node) {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(find).find(Boolean)
      if (node.type === 'button' && node.props.children?.[0] === pairFace.copy.bindExisting) return node
      return find(node.props?.children)
    })(renderCard())
    assert.ok(bindExisting !== undefined, 'the card offers binding an existing app')
    bindExisting.props.onClick()

    const askForAppId = () => collect(renderCard()).dialogs
      .find(dialog => dialog.props.open === true && dialog.props.title === pairFace.copy.bindExisting)
    const appIdDialog = askForAppId()
    assert.ok(appIdDialog !== undefined, 'which opens a dialog for the credentials')
    const fieldOf = id => (function find(node) {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(find).find(Boolean)
      if (node.type === 'input' && node.props.id === id) return node
      return find(node.props?.children)
    })(appIdDialog)
    const appIdInput = fieldOf('pocket-console-app-id')
    const secretInput = fieldOf('pocket-console-app-secret')
    assert.ok(appIdInput !== undefined && secretInput !== undefined, 'the dialog asks for both halves')
    assert.equal(secretInput.props.type, 'password', 'and hides the secret while it is typed')

    const connect = () => askForAppId().props.footer
      .find(node => node.props.children?.[0] === pairFace.copy.connect)
    assert.equal(connect().props.disabled, true, 'a half-filled form cannot connect')
    appIdInput.props.onChange({ target: { value: 'cli_from_console' } })
    assert.equal(connect().props.disabled, true, 'the id alone is not enough')
    askForAppId().props.children[1].props.children[1]
      .props.onChange({ target: { value: 'secret_from_console' } })

    const ready = connect()
    assert.equal(ready.props.disabled, false, 'both halves enable connecting')
    ready.props.onClick()
    await sleep(20)
    assert.ok(
      pressed.some(call => call.url.endsWith('/__pocket/adopt')
        && String(call.body).includes('"appId":"cli_from_console"')
        && String(call.body).includes('"appSecret":"secret_from_console"')),
      `connecting posts both halves: ${JSON.stringify(pressed)}`,
    )

    // Which of the two ways to bind applies depends on whether the reader has
    // scanned before, and only the copy can say so: an app created through the
    // scan already carries the permissions the other path has to be trusted with.
    FakeReact.cells[1] = { enrollment: { state: 'unbound' }, settings: {}, pending: [] }
    const guidance = collect(renderCard())
    assert.ok(guidance.texts.includes(pairFace.copy.guideFirst), 'a first-time reader is told to scan')
    assert.ok(guidance.texts.includes(pairFace.copy.guideReturning), 'and a returning one to reuse that app')

    // A pair the platform refused has to say so where the attempt was made.
    const refusedReason = 'App Secret 不正确，请在开发者后台的「凭证与基础信息」里重新复制'
    FakeReact.cells[1] = { enrollment: { state: 'failed', message: refusedReason }, settings: {}, pending: [] }
    const refused = collect(renderCard())
    assert.ok(refused.texts.includes(refusedReason), 'the reason is on the card')
    assert.ok(refused.texts.includes(pairFace.copy.bind), 'and both ways to bind are still offered')

    // Silence was the complaint: a connected deployment names the app, the
    // recipient, and whether the connection is up.
    FakeReact.cells[1] = {
      enrollment: { state: 'bound', appId: 'cli_connected', recipient: null, connected: true },
      settings: {},
      pending: [],
    }
    const connected = collect(renderCard())
    assert.ok(connected.texts.includes('cli_connected'), 'the card names the app it is bound to')
    assert.ok(connected.texts.includes(pairFace.copy.recipientNone), 'says the recipient is still unbound')
    assert.ok(connected.texts.includes(pairFace.copy.connected), 'and reports the connection as established')
    assert.ok(!connected.texts.includes(pairFace.copy.bind), 'offering no scan for an app already connected')
    assert.ok(!connected.texts.includes(pairFace.copy.bindExisting), 'and no second binding flow')
    assert.ok(connected.dialogs.every(dialog => dialog.props.open !== true), 'nothing is modal')

    // A pair the store could not keep is reported beside the working connection.
    FakeReact.cells[1] = {
      enrollment: { state: 'bound', appId: 'cli_connected', recipient: 'ou_x', connected: true, persisted: false },
      settings: {},
      pending: [],
    }
    assert.ok(collect(renderCard()).texts.includes(pairFace.copy.persistFailed), 'and an unkept pair says so')

    // A connection still being established reads as such, and never as bound.
    FakeReact.cells[1] = { enrollment: { state: 'starting' }, settings: {}, pending: [] }
    const connecting = collect(renderCard())
    assert.ok(connecting.texts.includes(pairFace.copy.startingConnecting), 'the card says it is connecting')
    assert.ok(!connecting.texts.includes(pairFace.copy.connected), 'and claims nothing it does not have')
    assert.ok(!connecting.texts.includes(pairFace.copy.bind), 'with no second attempt mid-flight')

    // Making the app is a different wait from connecting to it: the QR code is still
    // on its way, and the click must never look like nothing happened.
    FakeReact.cells[1] = { enrollment: { state: 'starting', stage: 'creating' }, settings: {}, pending: [] }
    assert.ok(
      collect(renderCard()).texts.includes(pairFace.copy.startingCreating),
      'creating the app says so while the code is on its way',
    )
    FakeReact.cells[1] = { enrollment: { state: 'starting', stage: 'creating', slow: true }, settings: {}, pending: [] }
    assert.ok(
      collect(renderCard()).texts.includes(pairFace.copy.startingCreatingSlow),
      'and a slow creation reads differently again',
    )
    FakeReact.cells[1] = { enrollment: { state: 'starting', stage: 'connecting', slow: true }, settings: {}, pending: [] }
    assert.ok(collect(renderCard()).texts.includes(pairFace.copy.startingConnectingSlow), 'as does a slow connection')

    const code = 'https://open.feishu.cn/page/launcher?user_code=X'
    FakeReact.cells[1] = { enrollment: { state: 'awaiting', verifyUrl: code }, settings: {}, pending: [] }
    const scanning = collect(renderCard())
    assert.ok(scanning.texts.includes(pairFace.copy.scan), 'a code that arrived shows the code')
    assert.ok(!scanning.texts.includes(pairFace.copy.startingCreating), 'and stops reporting the wait')

    // The page and the process serving it are replaced separately, so a card can
    // call a route the running host does not have. What a reader saw for that was a
    // bare 404; the card has to name the cause and the fix.
    FakeReact.cells[1] = { enrollment: { state: 'unbound' }, settings: {}, pending: [] }
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
    const startBinding = (function find(node) {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(find).find(Boolean)
      if (node.type === 'button' && node.props.children?.[0] === pairFace.copy.bind
        && node.props['aria-expanded'] === undefined) return node
      return find(node.props?.children)
    })(renderCard())
    assert.ok(startBinding !== undefined, 'the card offers creating an app')
    startBinding.props.onClick()
    await sleep(20)
    const outdated = collect(renderCard())
    assert.ok(outdated.texts.includes(pairFace.copy.hostOutdated), 'a missing route names the restart')
    assert.ok(
      !outdated.texts.some(text => typeof text === 'string' && text.includes('failed: 404')),
      'and not the bare status it used to show',
    )
  } finally {
    globalThis.fetch = previousUnbindFetch
  }
})

