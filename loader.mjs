/**
 * Registers the ESM resolve hook (hooks.mjs) so the compiled output in dist/ can
 * use the `@/*` path alias at runtime under plain Node — with NO extra dependency.
 *
 * Used only by the production start path: `node --import ./loader.mjs dist/index.js`.
 * `module.register` (Node 20.6+) is the SUPPORTED way to register loader hooks;
 * merely exporting `resolve` does nothing under `--import` (that only worked with
 * the now-deprecated `--loader` flag). Dev (`tsx`) and tests (`vitest`) resolve
 * the alias via their own configs; this is only for `node dist/...`.
 */
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
