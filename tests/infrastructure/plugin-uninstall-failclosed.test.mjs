import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const installer = readFileSync(new URL("../../server/routes/plugin-installer.ts", import.meta.url), "utf8");
const restart = readFileSync(new URL("../../server/utils/graceful-restart.ts", import.meta.url), "utf8");

function uninstallWindow() {
  const begin = installer.indexOf("await setPluginEnabled(name, false);");
  const end = installer.indexOf("scheduleServerRestart(`Plugin '${manifest.displayName}' uninstalled`)", begin);
  assert.ok(begin !== -1 && end > begin);
  return installer.slice(begin, end);
}

test("uninstall aborts on database disable failure before moving files", () => {
  const body = uninstallWindow();
  const disable = body.indexOf("await setPluginEnabled(name, false)");
  const error = body.indexOf("return res.status(503).json");
  const move = body.indexOf("fs.renameSync(targetDir, backupDir)");
  assert.ok(disable >= 0 && error > disable && move > error);
  assert.match(body, /files have been preserved/);
  assert.doesNotMatch(body, /uninstall; continuing/);
});

test("successful disable followed by rename failure schedules shutdown and explains the partial state", () => {
  const body = uninstallWindow();
  assert.match(body, /scheduleServerRestart\(`Plugin '\$\{manifest\.displayName\}' disabled after failed uninstall`\)/);
  assert.match(body, /enabled: false, requiresRestart: true, filesPreserved: true/);
  assert.match(body, /Plugin disablement saved, but files could not be removed/);
});

test("successful uninstall still schedules a restart and preserves the old backup", () => {
  assert.match(installer, /fs\.renameSync\(targetDir, backupDir\)/);
  assert.match(installer, /scheduleServerRestart\(`Plugin '\$\{manifest\.displayName\}' uninstalled`\)/);
  assert.match(installer, /tablesPreserved: manifest\.database\?\.tables \|\| \[\]/);
});

test("scheduled restart delegates to central shutdown rather than direct process exit", () => {
  assert.match(restart, /void gracefulShutdown\('plugin-restart'\)/);
  assert.doesNotMatch(restart, /^\s*process\.exit\(/m);
});
