/**
 * Plugin template entry point. Loaded by server/plugins/loader.ts.
 *
 * Contract:
 *   - The loader imports this file and calls the export named in plugin.json
 *     (registerFunction) as registerFunction(app, options), then awaits it.
 *   - options.adminAuthMiddleware is supplied by the loader and is required here.
 *   - Return { registered, reason, paths }. registered is false whenever nothing was mounted.
 *
 * Fail closed: nothing is mounted unless the env flag is exactly "true".
 */

const ENV_FLAG = 'TITAN_{{upper}}_ENABLED';
const BASE_PATH = '/api/plugins/{{name}}';

export function registerPlugin(app, options = {}) {
  const skip = (reason) => Object.freeze({ registered: false, reason, paths: Object.freeze([]) });

  if (process.env[ENV_FLAG] !== 'true') return skip(`${ENV_FLAG} is not "true"`);
  if (!app || typeof app.get !== 'function') return skip('no express app supplied');
  if (typeof options.adminAuthMiddleware !== 'function') return skip('no adminAuthMiddleware supplied');

  // Replace with real routes. Every route gets the admin auth middleware.
  const statusPath = `${BASE_PATH}/status`;
  app.get(statusPath, options.adminAuthMiddleware, (_req, res) => {
    res.json({ plugin: '{{name}}', ok: true });
  });

  return Object.freeze({ registered: true, reason: 'enabled', paths: Object.freeze([statusPath]) });
}
