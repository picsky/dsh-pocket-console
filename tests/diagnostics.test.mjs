/**
 * The debug switch: it has to actually switch something, and only when asked.
 *
 * Two ways this could be useless, and both are worth a case. A gate that never speaks is a setting
 * that lies — the reader turns it on, sees nothing, and concludes the plugin has nothing to say. A
 * gate that speaks when it is off is the reason the plugin's *warnings* stop being read: a
 * deployment that narrates everything all the time is a deployment whose one real warning is one
 * line among thousands.
 *
 * What it gates is deliberately narrow: the explanation of a decision, never the report of a failure.
 * A failed card write is a warning with or without this, which is the property that makes it safe to
 * leave off in production.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiagnostics, debugLogPath } from '../diagnostics.js'

/**
 * A gate wired to a recording logger and a scratch file.
 * @param settings - what the deployment's settings say.
 * @returns the gate, every line it logged, and the file it wrote to.
 */
function build(settings, path) {
  const said = []
  const diagnostics = createDiagnostics({
    settings: () => settings,
    log: { debug: (line) => { said.push(String(line)) } },
    path,
  })
  return { diagnostics, said }
}

/** A fresh scratch file for one case. */
const scratch = () => join(mkdtempSync(join(tmpdir(), 'pocket-diag-')), 'debug.log')

test('it says nothing while the deployment has not asked', () => {
  const { diagnostics, said } = build({ debug: 'off' }, scratch())
  diagnostics('活动卡：跳过——桌面持有优先侧。')
  assert.deepEqual(said, [], 'a deployment that did not ask to hear this hears nothing')
})

test('it speaks once the deployment asks', () => {
  const { diagnostics, said } = build({ debug: 'on' }, scratch())
  diagnostics('活动卡：为「s_1」创建（尚无消息 id）。')
  const about = said.filter(line => /创建/.test(line))
  assert.equal(about.length, 1, 'the line reaches the log: ' + said.join(' | '))
  assert.match(about[0], /pocket-console:/, 'and is attributable to this plugin: ' + about[0])
})

test('it follows the setting rather than reading it once', () => {
  // The setting is a live one — the settings card writes it while the process runs — so a gate that
  // captured it at load would keep narrating after it was switched off, or stay silent after it was
  // switched on. Both are indistinguishable from the bug it exists to diagnose.
  const settings = { debug: 'off' }
  const { diagnostics, said } = build(settings, scratch())
  diagnostics('第一条')
  settings.debug = 'on'
  diagnostics('第二条')
  settings.debug = 'off'
  diagnostics('第三条')

  assert.deepEqual(said.filter(line => /第一条|第三条/.test(line)), [], 'the off stretches are silent')
  assert.equal(said.filter(line => /第二条/.test(line)).length, 1, 'and the on stretch speaks')
})

test('it writes a file of its own, so the host\'s log level cannot hide it', () => {
  // The reason this outlet exists: Cordis exporters decide which levels reach a terminal and default
  // to `info`, so `log.debug` is invisible on a deployment started for ordinary use. A switch
  // documented as "turn this on to see why" that shows nothing at all teaches the reader that the
  // plugin has nothing to say — worse than having no switch.
  const path = scratch()
  const { diagnostics, said } = build({ debug: 'on' }, path)
  // The load announcement is a line of its own, so the file's first entry answers "was this
  // deployment actually in debug mode" before anything has happened to narrate.
  assert.match(readFileSync(path, 'utf8'), /调试模式已开启/, 'the file opens by naming the mode')
  diagnostics('活动卡：跳过——桌面持有优先侧。')

  assert.ok(said.length >= 2, 'the logger gets the announcement and the line')
  const written = readFileSync(path, 'utf8')
  assert.match(written, /桌面持有优先侧/, 'and so does the file: ' + written)
  assert.match(written, /^\d{4}-\d{2}-\d{2}T/, 'with a timestamp, so a sequence can be read back')
})

test('a deployment that never asked leaves no file behind', () => {
  // The switch belongs to the deployment: loading with it off must not create a file, or the reader
  // gets an empty log and concludes the switch is broken rather than off.
  const path = scratch()
  build({ debug: 'off' }, path)
  assert.throws(() => readFileSync(path, 'utf8'), 'nothing was written')
})

test('a file it cannot write to does not break the plugin', () => {
  // Diagnostics that could break the thing they describe would be the worst trade available. The path
  // here is a directory, so the append fails the way a full disk or a read-only home would.
  const directory = mkdtempSync(join(tmpdir(), 'pocket-diag-dir-'))
  const { diagnostics, said } = build({ debug: 'on' }, directory)

  assert.doesNotThrow(() => { diagnostics('写不进去也不该炸') }, 'the gate absorbs its own failure')
  assert.ok(said.some(line => /写不进去/.test(line)), 'and the logger still got the line: ' + said.join(' | '))
})

test('the log sits in the deployment\'s own home', () => {
  assert.equal(
    debugLogPath({ DSH_HOME: join('C:', 'scratch', 'dsh') }),
    join(join('C:', 'scratch', 'dsh'), 'pocket-console-debug.log'),
    'DSH_HOME decides where it goes',
  )
  assert.match(debugLogPath({}), /\.dsh/, 'and with none set it follows the default home')
})
