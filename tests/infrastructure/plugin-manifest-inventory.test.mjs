import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectPluginManifests } from "../../scripts/audit-plugin-manifests.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "supercharged-plugin-inventory-"));
  const write = (path, value) => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  try { return run({ root, write }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("manifest entrypoint is observed but registration and enablement remain unverified", () => fixture(({ root, write }) => {
  write("plugins/comms/plugin.json", {
    name: "comms", displayName: "Comms", entryPoint: "index.mjs", registerFunction: "registerPlugin",
  });
  write("plugins/comms/index.mjs", "export function registerPlugin() { return {registered:false}; }");
  const audit = inspectPluginManifests(root);
  assert.equal(audit.plugins.length, 1);
  assert.deepEqual(audit.plugins[0].entryCandidatesPresent, ["index.mjs"]);
  assert.equal(audit.plugins[0].flagName, "plugin_comms_enabled");
  assert.equal(audit.plugins[0].enabled, "unverified");
  assert.equal(audit.plugins[0].registered, "unverified");
  assert.equal(audit.plugins[0].runtime, "unverified");
  assert.deepEqual(audit.issues, []);
}));

test("TypeScript plugin manifests include compiled JS fallback candidates", () => fixture(({ root, write }) => {
  write("plugins/example/plugin.json", {name:"example", entryPoint:"index.ts", registerFunction:"registerPlugin"});
  write("plugins/example/index.mjs", "export const registerPlugin=()=>({registered:true});");
  const audit = inspectPluginManifests(root);
  assert.deepEqual(audit.plugins[0].entryCandidatesPresent, ["index.mjs"]);
  assert.equal(audit.issues.length, 0);
}));

test("mismatched directory and missing entrypoint are reported without importing code", () => fixture(({ root, write }) => {
  write("plugins/example/plugin.json", {name:"different", entryPoint:"missing.mjs", registerFunction:"registerPlugin"});
  const audit = inspectPluginManifests(root);
  assert.deepEqual(audit.issues.map(x=>x.code).sort(), ["directory_name_mismatch","entrypoint_not_found"]);
  assert.equal(audit.plugins[0].registered, "unverified");
}));

test("invalid manifests and duplicate names are surfaced and never discarded silently", () => fixture(({ root, write }) => {
  write("plugins/one/plugin.json", {name:"same",entryPoint:"index.mjs",registerFunction:"registerPlugin"});
  write("plugins/two/plugin.json", {name:"same",entryPoint:"index.mjs",registerFunction:"registerPlugin"});
  write("plugins/broken/plugin.json", "{");
  const audit = inspectPluginManifests(root);
  assert.equal(audit.plugins.length, 2);
  assert.equal(audit.issues.filter(x=>x.code==="directory_name_mismatch").length, 2);
  assert.equal(audit.issues.filter(x=>x.code==="duplicate_manifest_name").length, 1);
  assert.equal(audit.issues.filter(x=>x.code==="manifest_unreadable_or_invalid").length, 1);
}));

test("manifest entrypoint may not escape its plugin directory", () => fixture(({ root, write }) => {
  write("plugins/example/plugin.json", {name:"example",entryPoint:"../outside.mjs",registerFunction:"registerPlugin"});
  const report = inspectPluginManifests(root);
  assert.equal(report.plugins[0].entryCandidatesPresent.length, 0);
  assert.equal(report.issues.some(x=>x.code==="unsafe_or_missing_entrypoint"), true);
}));

test("a repository without plugins folder yields an empty read-only report", () => fixture(({root}) => {
  const report = inspectPluginManifests(root);
  assert.equal(report.plugins.length, 0);
  assert.equal(report.issues.length, 0);
}));
