import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../server/routes/plugin-installer.ts", import.meta.url), "utf8");
const installStart = source.indexOf("router.post('/install'");
const uninstallStart = source.indexOf("router.delete('/uninstall/");
assert.ok(installStart >= 0 && uninstallStart > installStart);
const install = source.slice(installStart, uninstallStart);

test("ZIP entry preflight precedes any upgrade backup or target removal", () => {
  const preflight = install.indexOf("for (const entry of zip.getEntries())");
  const safety = install.indexOf("!isSafeZipEntry(entryPath, targetDir)", preflight);
  const reject = install.indexOf("Unsafe plugin archive entry; existing files preserved", safety);
  const backup = install.indexOf("fs.cpSync(targetDir, backupDir");
  const remove = install.indexOf("fs.rmSync(targetDir", backup);
  assert.ok(preflight >= 0 && safety > preflight && reject > safety);
  assert.ok(backup > reject && remove > backup);
});

test("failed migration steps block activation and trigger file recovery", () => {
  const reject = install.indexOf("if (steps.some(step => step.status === 'failed'))");
  const enable = install.indexOf("await setPluginEnabled(pluginName, true)");
  assert.ok(reject > 0 && enable > reject);
  const recovery = install.slice(reject, enable);
  assert.match(recovery, /fs\.cpSync\(backupDir, targetDir/);
  assert.match(recovery, /Plugin installation failed; activation skipped/);
  assert.match(recovery, /databaseRollback: false/);
  assert.match(recovery, /return res\.status\(500\)\.json/);
});

test("activation persistence failure restores upgrade files and preserves backup", () => {
  const enable = install.indexOf("await setPluginEnabled(pluginName, true)");
  const marker = install.indexOf("Activation setting failed:", enable);
  const abort = install.indexOf("return res.status(503).json", marker);
  assert.ok(enable >= 0 && marker > enable && abort > marker);
  assert.match(install.slice(marker, abort), /fs\.cpSync\(backupDir, targetDir/);
  assert.match(install.slice(marker, abort + 260), /backupPreserved: isUpgrade/);
});

test("backup deletion occurs only when no installer step failed", () => {
  assert.match(install, /if \(isUpgrade && fs\.existsSync\(backupDir\) && steps\.every\(step => step\.status !== 'failed'\)\)/);
  assert.match(install, /fs\.rmSync\(backupDir, \{ recursive: true, force: true \}\)/);
});

test("a failed install cannot be reported as successfully activated", () => {
  assert.match(install, /const allSuccess = steps\.every\(s => s\.status !== 'failed'\)/);
  assert.match(install, /if \(allSuccess\) \{\s*scheduleServerRestart/);
  assert.match(install, /Plugin enabled for next startup; runtime registration pending restart/);
});
