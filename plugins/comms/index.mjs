/**
 * Comms plugin. Wraps existing modules and adds no logic of its own.
 *
 * Fail closed: nothing is registered unless TITAN_COMMS_ENABLED is exactly "true".
 * Importing this file has no side effects; wrapped modules load only when loadWrappedModules() is called.
 */

const ENV_FLAG = 'TITAN_COMMS_ENABLED';

/** Module name (as listed in plugin.json) to the existing module entry point. */
export const MODULE_ENTRIES = Object.freeze({
  chatbot: '../../server/modules/chatbot/index.ts',
  approvals: '../../server/modules/approvals/index.ts',
});

/** Imports each wrapped module by its existing entry point and returns them keyed by module name. */
export async function loadWrappedModules() {
  const loaded = {};
  for (const [name, relativePath] of Object.entries(MODULE_ENTRIES)) {
    loaded[name] = await import(new URL(relativePath, import.meta.url).href);
  }
  return Object.freeze(loaded);
}

export function registerPlugin(app, options = {}) {
  const skip = (reason) => Object.freeze({ registered: false, reason, paths: Object.freeze([]) });

  if (process.env[ENV_FLAG] !== 'true') return skip(`${ENV_FLAG} is not "true"`);
  if (!app || typeof app.get !== 'function') return skip('no express app supplied');
  if (typeof options.adminAuthMiddleware !== 'function') return skip('no adminAuthMiddleware supplied');

  // Mounting waits for the company_id migration (see server/modules/desk-modes/PORT-NOTES.md).
  return skip('mounting not yet approved');
}
