/**
 * What the plugin does when a Host capability it asks for is not there.
 *
 * Every seam in this plugin is asked for by capability rather than by version, which is
 * what lets one artifact load on both ends of the support window — and also what makes a
 * renamed or missing capability invisible: the plugin keeps working and quietly does less.
 * #89 was the expensive version of that (a settings form that was never served), and the
 * same shape recurs at a handful of other seams.
 *
 * The rule these cases hold is narrow and testable: a capability the plugin *cannot* work
 * without must fail loudly, and one it can work without must leave a trace a deployment
 * operator can read. What it must never do is draw a control that saves nowhere.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { scaffold } from './support/harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run one script in its own process and return its last stdout line.
 *
 * Some of these cases are about what happens *inside* a context Cordis owns, and the
 * harness runs one deployment per process, so they are probed out of process. The script
 * goes through a file rather than `-e`: a multi-line argument is split by the shell on
 * Windows before node ever sees it, which reads as "node: -e requires an argument" and
 * has nothing to do with what is being tested.
 * @param body - the script source.
 * @param name - a file name unique to this case.
 * @returns the last non-empty stdout line, or the last stderr line when it failed.
 */
function probeProcess(body, name) {
  const file = join(tmpdir(), `pocket-console-${name}-${process.pid}.mjs`)
  writeFileSync(file, body)
  try {
    // The stub resolution hook has to be registered before anything the probe imports:
    // it stands in for the production dependencies, exactly as it does for this process.
    // It is passed as a URL because a `C:\…` path is not an accepted `--import` target on
    // Windows — the ESM loader rejects the scheme before it ever opens the file.
    const hooks = pathToFileURL(fileURLToPath(new URL('./fixtures/hooks.mjs', import.meta.url))).href
    const result = spawnSync(process.execPath, ['--import', hooks, file], {
      cwd: root,
      encoding: 'utf8',
    })
    const lines = (result.stdout ?? '').trim().split('\n').filter(Boolean)
    if (lines.length > 0) return lines.at(-1)
    const errors = (result.stderr ?? '').trim().split('\n').filter(Boolean)
    return errors.slice(-3).join(' | ')
  } finally {
    rmSync(file, { force: true })
  }
}

test('a settings service with neither known method still loads, and says so', async () => {
  // The unsupported shape: a settings service whose contract moved out from under this
  // plugin. The card keeps drawing and keeps appearing to save, so the deployment log is
  // the only surface that can report it — and it names the capabilities it probed, so a
  // reader does not have to guess which name the Host renamed.
  const { infos, sections, routes, listenerOf } = await scaffold({}, {
    services: ['settings', 'webServer'],
    settingsSurface: 'unrecognized',
  })

  assert.equal(sections.size, 0, 'there is no section installer to call')
  assert.equal(routes.length, 1, 'the rest of the plugin is unaffected')
  const line = infos.find(entry => entry.includes('installSection'))
  assert.ok(line !== undefined, 'the log names the setting capabilities it probed')
  assert.match(line, /installSection=undefined/, 'with what each probe found')
  assert.match(line, /configure=undefined/, 'including the one 0.1.7 renamed')

  // The answerers are the part that must not depend on the settings surface at all.
  const desktop = Promise.withResolvers()
  const result = listenerOf('approval/request').handler(
    { toolName: 'pwsh', signal: new AbortController().signal },
    () => desktop.promise,
  )
  desktop.resolve('rejected')
  assert.equal(await result, 'rejected')
})

test('the settings surfaces the plugin does support leave no complaint', async () => {
  // The other direction, so the warning above cannot become noise on a healthy
  // deployment: the section installer and the form projection are both expected, and
  // neither is reported as unknown.
  for (const settingsSurface of ['section', 'forms']) {
    const { infos } = await scaffold({}, { services: ['settings'], settingsSurface })
    assert.equal(
      infos.some(entry => entry.includes('installSection')),
      false,
      `${settingsSurface}: a supported surface is not reported as unrecognized`,
    )
  }
})

test('an undeclared service read inside an inject callback fails here too', async () => {
  // Cordis throws for a service property read without an `inject` on the context that
  // reads it, and an injected child is a context like any other. The harness guarded only
  // the root, so a plugin could read anything inside a callback here and then throw on the
  // machine that installed it — and one of those reads already reached a user, which is
  // why the guard exists. This case holds the guard itself: the injected child refuses a
  // name its `inject` did not declare, exactly as the root does.
  const probe = `
    const { scaffold } = await import(${JSON.stringify(new URL('./support/harness.mjs', import.meta.url).href)})
    const seen = []
    const { ctx } = await scaffold({}, { services: ['settings'] })
    ctx.inject(['settings'], (scoped) => {
      try {
        seen.push(scoped.storageDomain)
      } catch (error) {
        seen.push(String(error.message))
      }
    })
    console.log(JSON.stringify(seen))
  `
  const line = probeProcess(probe, 'inject-child')
  assert.deepEqual(
    JSON.parse(line),
    ['cannot get property "storageDomain" without inject'],
    'an injected child refuses an undeclared read',
  )
})

test('the title service is handed a session, which is what it reads', async () => {
  // `sessionTitle.get(session)` takes the Session itself and calls `snapshotEvents()` on
  // it. The suite's title fake accepted `session?.id`, so a plugin that passed an id
  // passed here and threw on a real Host. The fake now refuses anything that is not a
  // session-shaped object, and this case proves the refusal is real — a fake that
  // accepts everything is how the last one hid a defect.
  const probe = `
    const { createSessionNames } = await import(${JSON.stringify(new URL('../session-names.js', import.meta.url).href)})
    const asked = []
    const session = { id: 's_1', snapshotEvents: () => [], header: { cwd: '/work/my-app' } }
    const ctx = {
      get: (name) => {
        if (name === 'agents') return { get: () => ({ session }) }
        if (name === 'sessionTitle') {
          return { get: (value) => {
            asked.push(typeof value)
            if (typeof value?.snapshotEvents !== 'function') throw new TypeError('sessionTitle.get expects a Session')
            return { title: '名字' }
          } }
        }
        return undefined
      },
    }
    const registry = createSessionNames({ ctx, messages: () => ({ logSessionNamed: () => '', sessionLine: (name) => '会话：' + name }), diagnostics: () => {} })
    const rendered = registry.subtitle('s_1')
    console.log(JSON.stringify({ asked, rendered }))
  `
  const result = probeProcess(probe, 'title-service')
  assert.deepEqual(
    JSON.parse(result),
    { asked: ['object'], rendered: '会话：名字' },
    'the service receives the session object, and the name renders',
  )
})

test('the channel members the plugin calls without a guard are the ones a module must provide', async () => {
  // `channel.subscribe` is the one member `apply` calls with no guard and no try/catch:
  // it runs inside the load effect, so a channel without it throws while the plugin is
  // being applied. That is the correct direction — a channel that cannot report presses
  // is not a channel — and it is worth pinning, because the same call made optional
  // would turn "this deployment cannot be answered from the phone" into a plugin that
  // loads and does nothing.
  //
  // The case reads the call sites rather than booting a transport: creating the real
  // Feishu channel would open a long connection onto a network this suite never uses.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // `(?<![\w.])` keeps `config.channel` — the configured module specifier, a string —
  // out of this: the call sites that matter are on the channel object, not on a property
  // that happens to share the name.
  const guarded = [...source.matchAll(/(?<![\w.])channel\.(\w+)\?\./g)].map(match => match[1])
  const unguarded = [...source.matchAll(/(?<![\w.])channel\.(\w+)\(/g)].map(match => match[1])

  assert.deepEqual(
    [...new Set(unguarded)].sort(),
    ['subscribe'],
    'exactly one channel member is called without a guard, and it is the one a channel cannot omit',
  )
  assert.ok(
    ['resume', 'enrollmentState', 'close'].every(member => guarded.includes(member)),
    `the optional members are asked for optionally: ${[...new Set(guarded)].sort().join(', ')}`,
  )

  // And the module this repository ships provides what it calls: the provider's own
  // surface is asserted in `channel-contract.test.mjs`, and here only that the file
  // exports the factory `index.js` requires.
  const provider = readFileSync(new URL('../providers/feishu.js', import.meta.url), 'utf8')
  assert.match(provider, /export async function create\b/, 'the bundled channel exports create()')
  assert.match(provider, /subscribe\(/, 'and answers subscribe, which the core calls unguarded')
})
