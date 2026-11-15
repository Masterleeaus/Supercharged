/**
 * Test-only resolve hook for PostgreSQL tests that load server modules directly.
 * - Maps the tsconfig alias '@shared/*' to the repo's shared/ folder.
 * - Server modules import sibling files without an extension (for example
 *   '../../services/audit-log'), which plain Node ESM does not resolve. Relative specifiers
 *   that fail to resolve are retried with '.ts' and '/index.ts'.
 * Registered only by the approvals PostgreSQL test. Not used by the app or by production code.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) {
    const target = join(repoRoot, 'shared', specifier.slice('@shared/'.length));
    const candidates = [`${target}.ts`, join(target, 'index.ts')];
    for (const candidate of candidates) {
      try {
        return await next(pathToFileURL(candidate).href, context);
      } catch {
        // try the next candidate
      }
    }
    return next(specifier, context);
  }
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!relative || /\.[cm]?[jt]sx?$|\.json$|\.mjs$/.test(specifier)) return next(specifier, context);
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await next(candidate, context);
      } catch {
        // try the next candidate
      }
    }
    throw error;
  }
}
