/**
 * Real-composition check.
 *
 * The unit suite builds its own context, which is the right shape for behaviour
 * and the wrong shape for activation: a hand-built context does not enforce
 * Cordis's service rules, so a plugin that reads an undeclared service, misnames
 * an export, or fails to activate still passes there — and then fails on the
 * machine that installed it.
 *
 * This script installs the packed tarball into a scratch profile and boots the
 * real application:
 *
 *   1. `npm pack` the working tree;
 *   2. `dsh plugin --profile e2e add` the tarball into a throwaway DSH_HOME;
 *   3. boot `dsh --profile e2e web` on an OS-chosen port;
 *   4. exchange the printed launch token for the browser cookie, then read
 *      `/__pocket/state` — and check the same route refuses the same request
 *      without that cookie.
 *
 * Step 4 is the composition proof: the route exists only if the Host half
 * activated inside the real Loader, installed its settings section, and got its
 * routes onto the real webserver.
 *
 * Run: npm run e2e
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

let server
try {
  console.log('packing the working tree…')
  run('npm', ['pack', '--pack-destination', work])
  const tarball = join(work, readdirSync(work).find(name => name.endsWith('.tgz')))
  check('the tarball was built', tarball.endsWith('.tgz'))

  const home = join(work, 'home')
  const env = { ...process.env, DSH_HOME: home }
  console.log('installing it into a scratch profile…')
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

  const refused = await fetch(`${origin}/__pocket/state`)
  check('and refuses a caller the connection does not trust', refused.status === 401, `status ${refused.status}`)
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
