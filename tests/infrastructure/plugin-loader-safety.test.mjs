import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const loader = readFileSync(new URL("../../server/plugins/loader.ts", import.meta.url), "utf8");
const manifestAudit = readFileSync(new URL("../../scripts/audit-plugin-manifests.mjs", import.meta.url), "utf8");

test("runtime discovery rejects symlink directories and manifest symlinks", () => {
  assert.match(loader, /entry\.isSymbolicLink\(\)/);
  assert.match(loader, /fs\.lstatSync\(manifestPath\)\.isSymbolicLink\(\)/);
});

test("runtime loader rejects manifest names different from actual plugin folder", () => {
  assert.match(loader, /\^\[a-z\]\[a-z0-9-\]\{1,63\}\$/);
  assert.match(loader, /manifest\.name !== entry\.name/);
  assert.match(loader, /const pluginPath = path\.join\(pluginsDir, manifest\.name\)/);
});

test("runtime loader rejects escaping relative module paths and invalid function identifiers", () => {
  assert.match(loader, /path\.isAbsolute\(manifest\.entryPoint\)/);
  assert.match(loader, /manifest\.entryPoint\.includes\('\\\\'\)/);
  assert.match(loader, /segment === '\.\.'/);
  assert.match(loader, /typeof manifest\.registerFunction !== 'string'/);
});

test("runtime loader checks realpath containment for both main entrypoint and compiled fallback", () => {
  assert.match(loader, /const pluginRoot = fs\.realpathSync\(pluginPath\)/);
  assert.match(loader, /const resolvedEntryPoint = fs\.realpathSync\(entryPointPath\)/);
  assert.match(loader, /resolvedEntryPoint\.startsWith\(pluginRoot \+ path\.sep\)/);
  assert.match(loader, /const resolvedFallback = fs\.realpathSync\(fallbackPath\)/);
  assert.match(loader, /resolvedFallback\.startsWith\(pluginRoot \+ path\.sep\)/);
});

test("inventory remains a separate read-only preview and does not activate plugins", () => {
  assert.match(manifestAudit, /registered: "unverified"/);
  assert.match(manifestAudit, /enabled: "unverified"/);
  assert.doesNotMatch(manifestAudit, /await import\(/);
});
