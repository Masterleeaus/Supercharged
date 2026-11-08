/**
 * Engine identity and feature flags.
 *
 * The engine is OFF unless TITAN_ENGINE___ENGINE_ENV___ENABLED is exactly "true".
 * The flag is read at call time, not cached at import, so tests can set it per case.
 *
 * Name tokens (__ENGINE_NAME__, __ENGINE_PASCAL__, __ENGINE_ENV__, __ENGINE_VERSION__,
 * __PROVIDER_NAME__, __PROVIDER_PASCAL__) are replaced by scripts/new-engine.mjs.
 */

export const ENGINE_NAME = '__ENGINE_NAME__';
export const ENGINE_VERSION = '__ENGINE_VERSION__';

/** Provider id for the single provider skeleton that ships with the template. */
export const PROVIDER_ID = '__PROVIDER_NAME__';

export const ENGINE_FLAG = 'TITAN_ENGINE___ENGINE_ENV___ENABLED';

export function isEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENGINE_FLAG] === 'true';
}
