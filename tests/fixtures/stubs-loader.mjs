/**
 * Module resolution hook for the test suite.
 *
 * The plugin imports its production dependencies by bare specifier. The suite
 * replaces seven of them with in-repo stubs so it can run with nothing
 * installed, no credentials, and no network — and so the plugin itself needs no
 * test-only seam.
 *
 * Both the plugin and `verify.mjs` resolve the same specifier to the same file
 * URL, which is what keeps them on one module instance: the suite reads the
 * stub's call log, and the plugin writes to it.
 */

/** Production specifier to the stub that stands in for it. */
const STUBS = new Map([
  ['@larksuiteoapi/node-sdk', './stubs/lark-sdk.mjs'],
  ['@deepseek-ai/dsh-credentials', './stubs/credentials.mjs'],
  ['@deepseek-ai/dsh-llm', './stubs/llm.mjs'],
  ['@deepseek-ai/schemastery', './stubs/schemastery.mjs'],
  ['@deepseek-ai/dsh-storage-domain', './stubs/storage-domain.mjs'],
  ['qrcode', './stubs/qrcode.mjs'],
  ['zod', './stubs/zod.mjs'],
])

/**
 * Redirect the stubbed specifiers and delegate everything else.
 * @param specifier - the import specifier being resolved.
 * @param context - resolution context supplied by Node.
 * @param next - the default resolver.
 * @returns the resolved module URL.
 */
export async function resolve(specifier, context, next) {
  const target = STUBS.get(specifier)
  if (target !== undefined) {
    return { url: new URL(target, import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
