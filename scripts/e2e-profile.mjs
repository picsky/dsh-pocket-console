/**
 * Real-composition check: the artifact, in the application, on a named harness.
 *
 * The unit suite builds its own context, which is the right shape for behaviour
 * and the wrong shape for activation: a hand-built context does not enforce
 * Cordis's service rules, so a plugin that reads an undeclared service, misnames
 * an export, or fails to activate still passes there — and then fails on the
 * machine that installed it.
 *
 * This script takes a tarball and verifies it against a real application:
 *
 *   1. take a tarball — `npm run e2e` packs the working tree, and
 *      `npm run verify:artifact -- <tarball>` checks one already built, which is
 *      what a release verifies *before* it publishes, so the artifact checked and
 *      the artifact published are the same file;
 *   2. `dsh plugin --profile e2e add` it into a throwaway DSH_HOME;
 *   3. boot `dsh --profile e2e web` on an OS-chosen port;
 *   4. exchange the printed launch token for the browser cookie, then read
 *      `/__pocket/state` — and check the same route refuses the same request
 *      without that cookie;
 *   5. read the page the browser would boot, and the client bundle it would load:
 *      the boot manifest must carry this plugin's entry, and the served bundle must
 *      be this package's own `client.js`, because a bundle that is not the one
 *      verified is the failure the first four steps cannot see.
 *
 * Step 4 is the composition proof: the route exists only if the Host half
 * activated inside the real Loader, installed its settings section, and got its
 * routes onto the real webserver. Step 5 is the browser half's proof, as far as it
 * can be taken without a browser: the entry the shell will boot, and the very bytes
 * it will run.
 *
 * The `dsh` on PATH decides which harness is verified, so a release runs this once
 * per supported harness. The version it actually got is printed rather than
 * assumed.
 *
 * Run: npm run e2e
 *      npm run verify:artifact -- dsh-pocket-console-0.9.5.tgz
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pocket-console-e2e-'))
const failures = []

/** Record one check's outcome. */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/** Run one command to completion. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/**
 * Pack the working tree and return the tarball's name.
 *
 * `pnpm` packs it, because `pnpm` is what a release publishes with: the tarball
 * this check installs is then the one a release builds. `npm` is the fallback for
 * a checkout that installed with npm.
 *
 * npm 11 can end a successful pack with `Exit handler never called!` — a crash in
 * npm's own shutdown on a CI runner, after the tarball is written. Packing is not
 * what this check asserts; installing the tarball into a real profile and booting
 * the application is, and a tarball that lost a file fails there.
 * @param destination - the directory both packers write into.
 * @returns the file name written there.
 */
function pack(destination) {
  const missing = []
  for (const command of ['pnpm', 'npm']) {
    const args = ['pack', '--pack-destination', destination]
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const written = readdirSync(destination).find(name => name.endsWith('.tgz'))
    if (result.error?.code === 'ENOENT') {
      missing.push(command)
      continue
    }
    if (result.status === 0 && written !== undefined) return written
    if (written !== undefined && /Exit handler never called/.test(output)) {
      console.log(`note: ${command} crashed in its own shutdown after writing the tarball; using it`)
      return written
    }
    throw new Error(`${command} ${args.join(' ')} failed:\n${output}`)
  }
  throw new Error(`neither pnpm nor npm is installed, so the tree cannot be packed: ${missing.join(', ')}`)
}

/** Stop a server and everything it started. */
function stop(child) {
  if (child === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })

/** Poll a URL until it answers, or give up. */
async function waitFor(url, options, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (response.status !== 502 && response.status !== 503) return response
    } catch {
      // Not listening yet.
    }
    await sleep(500)
  }
  throw new Error(`no answer from ${url}`)
}

/**
 * The boot manifest the page carries.
 *
 * Read by matching braces rather than by pattern: the shell assigns it to
 * `window["__DSH_BOOT__"]` in one release and `window.__DSH_BOOT__` in another, and a
 * regular expression anchored on either spelling turns a browser-side fact into a
 * parsing accident. The first `{` after the name opens the object, and the scan is
 * string-aware so a brace inside a URL cannot end it early.
 * @param html - the page the shell served.
 * @returns the parsed manifest, or undefined when the page carries none.
 */
function bootManifest(html) {
  const at = html.indexOf('__DSH_BOOT__')
  if (at === -1) return undefined
  const start = html.indexOf('{', at)
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * The settings form this deployment's Host actually builds for the entry.
 *
 * Booting the application proves the Host half activated, and the boot manifest
 * proves the browser half is the tarball's. Neither says whether a person can see
 * the settings: the form exists only if the marker the Host's projection is keyed on
 * reached the Host's own copy of the schema library. That is what #89 cost — a
 * profile resolved a schemastery older than the Host's, the plugin asked for a helper
 * that copy did not have, no marker was written, and the Plugins page listed the
 * plugin with nothing to edit while every check here and in the unit suite passed.
 *
 * `scripts/probe-installed-form.mjs` does the asking, in its own process and against
 * the real library the profile resolved: a stand-in is exactly what could not see
 * this failure. The version the probe found is reported, because "a form is served"
 * means different things on a library with `volatile()` and one without, and both are
 * shapes a deployment may legitimately resolve.
 * @param home - the scratch `DSH_HOME`.
 * @param pluginDir - the installed copy of this package inside that profile.
 * @param harnessVersion - the harness on `PATH`, for the failure message.
 * @returns `{ ok, detail }`, plus the field names when it reached them.
 */
function settingsProbe(home, pluginDir, harnessVersion) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'probe-installed-form.mjs'), pluginDir, join(home, 'profiles', 'web', 'node_modules')],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  )
  const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(line)
  } catch {
    const last = (result.stderr ?? '').trim().split('\n').at(-1)
    return { ok: false, detail: `${harnessVersion}: the probe answered nothing usable (${last ?? `status ${result.status}`})` }
  }
}

let server
try {
  // An argument names an artifact to verify; without one the working tree is packed,
  // which is what a contributor runs. A release always names the tarball it is about
  // to publish, so the bytes verified and the bytes published cannot differ.
  const named = process.argv[2]
  let tarball
  if (named === undefined) {
    console.log('packing the working tree…')
    const built = pack(work)
    tarball = join(work, built)
    check('the tarball was built', tarball.endsWith('.tgz'), built)
  } else {
    tarball = resolve(named)
    check('the named tarball exists', existsSync(tarball), tarball)
    console.log(`verifying the artifact ${basename(tarball)}…`)
  }

  const harness = run('dsh', ['--version']).trim().split('\n').at(-1)?.trim() ?? ''
  check('the harness is the one on PATH', harness !== '', harness)

  const home = join(work, 'home')
  const env = { ...process.env, DSH_HOME: home }
  console.log(`installing it into a scratch profile for DSH ${harness}…`)
  // The web profile carries the application layer the plugin mounts into, and
  // dsh composes that profile's bundles itself.
  run('dsh', ['plugin', '--profile', 'web', 'add', tarball], { env })

  const manifest = join(home, 'profiles', 'web', 'package.json')
  const declared = JSON.parse(readFileSync(manifest, 'utf8'))
  check(
    'the profile depends on the plugin',
    Object.keys(declared.dependencies ?? {}).includes('dsh-pocket-console'),
    JSON.stringify(declared.dependencies ?? {}),
  )

  console.log('booting the real application…')
  server = spawn('dsh', ['web', '--port', '0', '--no-open'], {
    cwd: root,
    env,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', (chunk) => { output += chunk })
  server.stderr.on('data', (chunk) => { output += chunk })

  let url
  for (let attempt = 0; attempt < 120 && url === undefined; attempt += 1) {
    const match = /https?:\/\/[^\s"']*\?token=[A-Za-z0-9_-]+/.exec(output)
    if (match !== null) url = match[0]
    else await sleep(250)
  }
  if (url === undefined) {
    throw new Error(`the launch URL never appeared:\n${output}`)
  }
  const origin = new URL(url).origin
  check('the application booted and printed its launch URL', true, origin)

  check(
    'the plugin activated',
    !/dsh-pocket-console[^\n]*(did not activate|import failed|load failure)/i.test(output),
    output.split('\n').filter(line => line.includes('pocket-console')).slice(0, 3).join(' | '),
  )

  // The launch token is a one-shot exchange for the browser cookie, which is
  // what the trust fence accepts from then on.
  const exchange = await fetch(url, { redirect: 'manual' })
  const cookie = (exchange.headers.getSetCookie?.() ?? [])
    .map(entry => entry.split(';')[0])
    .join('; ')
  check('the launch URL produced a browser session', cookie !== '', `status ${exchange.status}`)

  const state = await waitFor(`${origin}/__pocket/state`, { headers: { cookie } })
  const snapshot = state.status === 200 ? await state.json() : {}
  check(
    'the state route answers a real browser session',
    state.status === 200 && snapshot.namespace === 'pocket-console',
    `status ${state.status} namespace ${String(snapshot.namespace)}`,
  )
  check(
    'the composed settings are served',
    snapshot.settings?.delaySeconds !== undefined && snapshot.settings?.mirrorTtlSeconds !== undefined,
    JSON.stringify(snapshot.settings ?? {}),
  )

  // The exit a person actually meets. Everything above this can be green while the
  // Plugins page lists a plugin whose settings cannot be edited — the shape #89
  // shipped — so the form is asked for by name, in the profile that was installed.
  const installedDir = join(home, 'profiles', 'web', 'node_modules', 'dsh-pocket-console')
  const form = settingsProbe(home, installedDir, harness)
  check('the Host serves this entry a settings form', form.ok === true, form.detail ?? '')
  if (form.ok === true) {
    check(
      'and the form offers exactly the fields the card edits',
      JSON.stringify(form.fields) === JSON.stringify(['delaySeconds', 'titlePrefix', 'resultNotify', 'debug']),
      (form.fields ?? []).join(', '),
    )
  }

  const refused = await fetch(`${origin}/__pocket/state`)
  check('and refuses a caller the connection does not trust', refused.status === 401, `status ${refused.status}`)

  // The browser half and the Host half are replaced separately — the page can be
  // newer than the process serving it, which is how a card ends up calling a route
  // that is not there. Every route the card calls must exist on the host, and an
  // untrusted request answering 401 rather than 404 is what proves it does.
  const routes = [
    ['GET', '/__pocket/state'],
    ['GET', '/__pocket/qr.svg'],
    ['POST', '/__pocket/bind'],
    ['POST', '/__pocket/adopt'],
    ['POST', '/__pocket/unbind'],
    ['POST', '/__pocket/mirror'],
  ]
  for (const [method, path] of routes) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    check(`${path} exists on the host that serves the card`, response.status !== 404, `status ${response.status}`)
  }

  // The browser half, as far as it can be checked without a browser. The shell boots
  // exactly the entries in its boot manifest, and runs exactly the bundle each row
  // points at — so those two facts are the ones a release can verify before publishing,
  // and the two that were wrong when a card mounted and rendered nothing on 0.1.7.
  const page = await fetch(origin, { headers: { cookie } })
  const html = await page.text()
  const boot = bootManifest(html)
  check('the page carries a boot manifest', boot !== undefined, `${html.length} bytes of HTML`)
  const row = boot?.entries?.find((entry) => entry.id === 'dsh-pocket-console')
  check(
    "the shell will boot this plugin's browser half",
    row !== undefined,
    row === undefined
      ? `no dsh-pocket-console entry among ${boot?.entries?.length ?? 0} entries`
      : `rev ${String(row.rev)}`,
  )
  if (row !== undefined) {
    const served = await (await fetch(new URL(row.url, origin))).text()
    const installed = readFileSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-pocket-console', 'client.js'), 'utf8').trim()
    check(
      'the bundle the browser runs is the one this tarball installed',
      served.includes(installed),
      `served ${served.length} bytes around a ${installed.length}-byte client.js`,
    )
  }
} catch (error) {
  check('the check ran to completion', false, error instanceof Error ? error.message : String(error))
} finally {
  stop(server)
  await sleep(500)
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nreal-composition check failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nreal-composition check passed')
