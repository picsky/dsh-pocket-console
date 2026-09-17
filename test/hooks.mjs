/**
 * Registers the stub resolution hook before the suite loads.
 *
 * `npm test` runs `node --import ./test/hooks.mjs verify.mjs`, so the hook is in
 * place before either the suite or the plugin resolves a dependency.
 */
import { register } from 'node:module'

register('./stubs-loader.mjs', import.meta.url)
