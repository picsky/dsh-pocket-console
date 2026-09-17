/**
 * Registers the stub resolution hook before the suite loads.
 *
 * `npm test` runs `node --import ./tests/fixtures/hooks.mjs --test`, so the hook is in
 * place before either the suite or the plugin resolves a dependency.
 */
import { register } from 'node:module'

register('./stubs-loader.mjs', import.meta.url)
