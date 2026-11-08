#!/usr/bin/env node
/**
 * Read-only manifest inventory for Supercharged's dynamically discovered plugins.
 *
 * The runtime loader discovers plugins/plugin.json from process.cwd() and chooses
 * entryPoint / registerFunction from each manifest. File presence cannot prove
 * enabling, successful import, permissions, persistence, or route registration.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function inspectPluginManifests(root = ROOT) {
  const directory = realpathSync(resolve(root));
  const pluginsDirectory = join(directory, "plugins");
  const result = {
    scannedDirectory: pluginsDirectory,
    plugins: [],
    issues: [],
    caveat: "Manifest and entrypoint presence cannot establish enabled status or live routes; runtime flags, auth, providers, and registration remain unverified.",
  };
  if (!existsSync(pluginsDirectory)) return result;

  for (const entry of readdirSync(pluginsDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const manifestFile = join(pluginsDirectory, entry.name, "plugin.json");
    if (!existsSync(manifestFile)) continue;
    const manifestPath = relative(directory, manifestFile).split(sep).join("/");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch {
      result.issues.push({ manifestPath, code: "manifest_unreadable_or_invalid" });
      continue;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      result.issues.push({ manifestPath, code: "manifest_not_object" });
      continue;
    }
    const name = typeof manifest.name === "string" ? manifest.name : null;
    const entryPoint = typeof manifest.entryPoint === "string" ? manifest.entryPoint : null;
    const registerFunction = typeof manifest.registerFunction === "string" ? manifest.registerFunction : null;
    if (name !== entry.name) result.issues.push({ manifestPath, code: "directory_name_mismatch" });
    if (!entryPoint || entryPoint.startsWith("/") || entryPoint.split(/[\\/]/).includes("..")) {
      result.issues.push({ manifestPath, code: "unsafe_or_missing_entrypoint" });
    }
    const candidates = entryPoint && !entryPoint.startsWith("/") && !entryPoint.split(/[\\/]/).includes("..")
      ? entryPoint.endsWith(".ts")
        ? [entryPoint, entryPoint.replace(/\.ts$/, ".js"), entryPoint.replace(/\.ts$/, ".cjs"), entryPoint.replace(/\.ts$/, ".mjs")]
        : [entryPoint]
      : [];
    const present = candidates.filter((candidate) => existsSync(join(pluginsDirectory, entry.name, candidate)));
    if (candidates.length && !present.length) result.issues.push({ manifestPath, code: "entrypoint_not_found" });
    result.plugins.push({
      directory: entry.name,
      manifestPath,
      name,
      displayName: typeof manifest.displayName === "string" ? manifest.displayName : null,
      entryPoint,
      registerFunction,
      entryCandidatesPresent: present,
      flagName: name ? `plugin_${name}_enabled` : null,
      enabled: "unverified",
      registered: "unverified",
      runtime: "unverified",
    });
  }
  const byName = new Map();
  for (const plugin of result.plugins) {
    if (!plugin.name) continue;
    const dirs = byName.get(plugin.name) || [];
    dirs.push(plugin.directory);
    byName.set(plugin.name, dirs);
  }
  for (const [name, dirs] of byName) {
    if (dirs.length > 1) result.issues.push({ code: "duplicate_manifest_name", name, directories: dirs });
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--json" && a !== "--help" && !a.startsWith("--root="))) {
    throw new Error("Usage: node scripts/audit-plugin-manifests.mjs [--root=/path] [--json]");
  }
  if (args.includes("--help")) {
    console.log("Usage: node scripts/audit-plugin-manifests.mjs [--root=/path] [--json]");
    return;
  }
  const root = args.find((a) => a.startsWith("--root="))?.slice("--root=".length) || ROOT;
  const report = inspectPluginManifests(root);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const plugin of report.plugins) console.log(`${plugin.name}: ${plugin.entryCandidatesPresent.join(", ") || "entrypoint absent"} (enabled/registered: unverified)`);
    for (const issue of report.issues) console.log(`ISSUE ${issue.code}: ${issue.manifestPath || issue.name}`);
    console.log(report.caveat);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
