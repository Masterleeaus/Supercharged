# Plugin template

A skeleton for a folder in `plugins/` that the plugin loader (`server/plugins/loader.ts`) discovers, imports and registers.
It is disabled by default: it mounts nothing unless `TITAN_{{upper}}_ENABLED` is exactly `true`.

## Create a plugin

Option A, generator (recommended):

    node scripts/new-module.mjs my-plugin --plugin

This copies this folder to `plugins/my-plugin/` and fills in the name tokens. It refuses to overwrite an existing folder.

Option B, by hand: copy this folder to `plugins/<your-name>/` and replace `{{name}}`, `{{title}}` and `{{upper}}` with your values.

## Steps

1. **Name it.** Use lowercase kebab-case (`my-plugin`). `plugin.json` `name` must be unique across `plugins/`.
2. **Fill in `plugin.json`.** Required keys: `name`, `displayName`, `version`, `description`, `author`, `entryPoint`, `registerFunction`, `features`. Set `entryPoint` to the file you ship and `registerFunction` to the exported function name.
3. **Write the register function.** `index.mjs` exports `registerPlugin(app, options)`. It returns `{ registered, reason, paths }`. Return `registered: false` with a reason for every skip path.
4. **Keep the gate.** The env check is the first thing the function does. Keep `process.env[ENV_FLAG] !== 'true'` as the first branch. Keep the `adminAuthMiddleware` check, so routes never mount without auth.
5. **Add routes.** Mount every route with `options.adminAuthMiddleware` (or a stricter guard). Record each path in `paths`.
6. **Enable it.** Set `TITAN_<NAME>_ENABLED=true` in the environment for the target deployment, then restart the server. This is the only step that turns the plugin on.
7. **Verify.** Hit `/api/plugins/<name>/status` with an admin token. Run `node --test tests/templates/templates.test.mjs` to confirm the template still generates cleanly.

## Things the loader does that you should know

- The loader enables a plugin by default when no `plugin_<name>_enabled` row exists in `globalSettings`. The env flag is therefore the real gate, not the database toggle.
- Discovery looks at every directory in `plugins/` that holds a `plugin.json`. This template lives in `docs/templates/` so it is never discovered. Do not move it under `plugins/`.
- `database.migrations` runs only `.sql` files inside the plugin folder. This template declares no database, so it has none.
- The loader awaits the register function but ignores its return value. Logging and the returned `paths` are for your own checks.
