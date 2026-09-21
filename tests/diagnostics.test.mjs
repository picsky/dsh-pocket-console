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
import { createDiagnostics } from '../diagnostics.js'

/**
 * A gate wired to a recording logger.
 * @param settings - what the deployment's settings say.
 * @returns the gate and every line it produced.
 */
function build(settings) {
  const said = []
  const diagnostics = createDiagnostics({
    settings: () => settings,
    log: { debug: (line) => { said.push(String(line)) } },
    messages: () => ({}),
  })
  return { diagnostics, said }
}

test('it says nothing while the deployment has not asked', () => {
  const { diagnostics, said } = build({ debug: 'off' })
  diagnostics('活动卡：跳过——桌面持有优先侧。')
  assert.deepEqual(said, [], 'a deployment that did not ask to hear this hears nothing')
})

test('it speaks once the deployment asks', () => {
  const { diagnostics, said } = build({ debug: 'on' })
  diagnostics('活动卡：为「s_1」创建（尚无消息 id）。')
  assert.equal(said.length, 1, 'the line reaches the log')
  assert.match(said[0], /pocket-console:/, 'and is attributable to this plugin: ' + said[0])
  assert.match(said[0], /创建/, 'and is the line that was asked for')
})

test('it follows the setting rather than reading it once', () => {
  // The setting is a live one — the settings card writes it while the process runs — so a gate that
  // captured it at load would keep narrating after it was switched off, or stay silent after it was
  // switched on. Both are indistinguishable from the bug it exists to diagnose.
  const settings = { debug: 'off' }
  const { diagnostics, said } = build(settings)
  diagnostics('第一条')
  settings.debug = 'on'
  diagnostics('第二条')
  settings.debug = 'off'
  diagnostics('第三条')

  assert.deepEqual(said.filter(line => /第一条|第三条/.test(line)), [], 'the off stretches are silent')
  assert.equal(said.filter(line => /第二条/.test(line)).length, 1, 'and the on stretch speaks')
})
