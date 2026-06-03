/**
 * Tiny ESM resolver hook so the compiled output (dist/) can use the `@/*` path
 * alias at runtime under plain Node — with NO extra dependency (no tsc-alias).
 *
 * tsconfig maps `@/* -> src/*`; after `tsc`, those imports become `@/foo.js`
 * inside dist/. This hook rewrites a leading `@/` to an absolute file URL under
 * dist/, so `node --import ./loader.mjs dist/index.js` resolves them.
 *
 * Dev (`tsx`) and tests (`vitest`) resolve the alias via their own configs;
 * this hook is ONLY needed for the production `node dist/...` path. See README
 * "Path alias / runtime resolution".
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolvePath(here, 'dist');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = resolvePath(DIST, specifier.slice(2));
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
