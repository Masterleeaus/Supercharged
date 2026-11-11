#!/usr/bin/env node
/**
 * Read-only source duplication audit for the Supercharged repository.
 *
 * Unlike a Git tree snapshot, this can also examine the current working tree,
 * including uncommitted edits. It does not move, modify or delete any file.
 * Equality is verified using SHA-256 over file bytes, not filename guesses.
 */
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", ".next", "coverage"]);
const SOURCE_ROOTS = new Set(["client", "server", "tests", "migrations", "scripts", "plugins", "packages", "shared"]);

export function classifySourcePath(path) {
  const first = path.split("/")[0];
  if (first === "_TITAN_HANDOFF") return "donor";
  if (first === "dist") return "generated";
  if (first === "vendor") return "vendor";
  if (SOURCE_ROOTS.has(first)) return "active-tree";
  return "root";
}

function *walkFiles(root, directory = root) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield *walkFiles(root, absolute);
    } else if (entry.isFile() && lstatSync(absolute).isFile()) {
      yield { absolute, relativePath: relative(root, absolute).split(sep).join("/") };
    }
  }
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function auditSourceDuplicates(root = DEFAULT_ROOT) {
  const absoluteRoot = realpathSync(resolve(root));
  const hashes = new Map();
  let files = 0;
  for (const file of walkFiles(absoluteRoot)) {
    files++;
    const sha256 = await digestFile(file.absolute);
    if (!hashes.has(sha256)) hashes.set(sha256, []);
    hashes.get(sha256).push(file.relativePath);
  }

  const groups = [];
  for (const [sha256, paths] of hashes) {
    if (paths.length < 2) continue;
    paths.sort();
    const categories = [...new Set(paths.map(classifySourcePath))].sort();
    groups.push({
      sha256,
      paths,
      categories,
      activeAndDonor: categories.includes("active-tree") && categories.includes("donor"),
      activeAndGenerated: categories.includes("active-tree") && categories.includes("generated"),
    });
  }
  groups.sort((a, b) => a.paths[0].localeCompare(b.paths[0]));

  return {
    root: absoluteRoot,
    fileCount: files,
    uniqueHashes: hashes.size,
    duplicateGroups: groups.length,
    duplicatedPaths: groups.reduce((total, group) => total + group.paths.length, 0),
    activeDonorGroups: groups.filter((group) => group.activeAndDonor).length,
    activeGeneratedGroups: groups.filter((group) => group.activeAndGenerated).length,
    groups,
    destructiveChanges: 0,
    caveat: "Exact bytes do not establish import ownership, deployment use, licensing, or safe deletion.",
  };
}

async function cli() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((arg) => !["--json", "--help"].includes(arg) && !arg.startsWith("--root="))) {
    throw new Error("Usage: node scripts/audit-source-duplicates.mjs [--root=/path] [--json]");
  }
  if (argumentsList.includes("--help")) {
    console.log("Usage: node scripts/audit-source-duplicates.mjs [--root=/path] [--json]");
    return;
  }
  const rootArg = argumentsList.find((arg) => arg.startsWith("--root="));
  const report = await auditSourceDuplicates(rootArg ? rootArg.slice("--root=".length) : DEFAULT_ROOT);
  if (argumentsList.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Files: ${report.fileCount}; hashes: ${report.uniqueHashes}; duplicate groups: ${report.duplicateGroups}`);
  console.log(`Active/donor groups: ${report.activeDonorGroups}; active/generated groups: ${report.activeGeneratedGroups}`);
  for (const group of report.groups) {
    console.log(`\n${group.sha256.slice(0, 12)} [${group.categories.join(", ")}]\n  ${group.paths.join("\n  ")}`);
  }
  console.log(`\n${report.caveat}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(error); process.exitCode = 1; });
}
