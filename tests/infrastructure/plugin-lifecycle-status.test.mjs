import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const loader = readFileSync(new URL("../../server/plugins/loader.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../server/routes/plugin-routes.ts", import.meta.url), "utf8");
const installer = readFileSync(new URL("../../server/routes/plugin-installer.ts", import.meta.url), "utf8");

function pendingRestart(enabled, registered) {
  return enabled !== registered;
}

test("enable and disable both require restart when registration state differs", () => {
  assert.equal(pendingRestart(true, false), true);
  assert.equal(pendingRestart(false, true), true);
  assert.equal(pendingRestart(false, false), false);
  assert.equal(pendingRestart(true, true), false);
  assert.match(loader, /requiresRestart: !plugin\.error && plugin\.enabled !== plugin\.registered/);
});

test("loader preserves current-process registration and exposes configured state separately", () => {
  assert.match(loader, /registered: plugin\.registered/);
  assert.match(loader, /enabled: plugin\.enabled/);
  assert.match(loader, /plugin\.enabled = enabled/);
  assert.doesNotMatch(loader, /plugin\.registered = enabled/);
});

test("public plugin health identifies pending restart instead of reporting a healthy runtime", () => {
  assert.match(routes, /status: 'ok' \| 'error' \| 'disabled' \| 'pending_restart'/);
  assert.match(routes, /if \(plugin\.enabled !== plugin\.registered\) \{/);
  assert.match(routes, /status = 'pending_restart'/);
  assert.match(routes, /if \(plugin\.error \|\| missingTables\.length > 0\)/);
});

test("plugin installer does not claim to have registered a newly enabled plugin before restart", () => {
  assert.doesNotMatch(installer, /message: 'Plugin registered and enabled'/);
  assert.match(installer, /Plugin enabled for next startup; runtime registration pending restart/);
  assert.match(installer, /requiresRestart: true/);
  assert.match(installer, /scheduleServerRestart/);
});

test("admin enable and disable endpoints persist settings and schedule a restart", () => {
  assert.match(routes, /await setPluginEnabled\(name, true\)/);
  assert.match(routes, /await setPluginEnabled\(name, false\)/);
  assert.match(routes, /scheduleServerRestart\(`Plugin '\$\{manifest\.displayName\}' enabled`\)/);
  assert.match(routes, /scheduleServerRestart\(`Plugin '\$\{manifest\.displayName\}' disabled`\)/);
});
