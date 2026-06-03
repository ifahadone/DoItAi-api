/**
 * ESM resolve hook: rewrite a leading `@/` specifier to the matching file under
 * dist/ (tsconfig maps `@/* -> src/*`; after `tsc` those become `@/foo.js` in the
 * emitted output). Registered by loader.mjs via `module.register`, so it runs on
 * the dedicated hooks thread and applies to every subsequent import.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const DIST = resolvePath(dirname(fileURLToPath(import.meta.url)), 'dist');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = resolvePath(DIST, specifier.slice(2));
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
