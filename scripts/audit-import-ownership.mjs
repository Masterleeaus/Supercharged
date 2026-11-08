#!/usr/bin/env node
/**
 * Conservative, read-only import/loader ownership audit.
 *
 * This is a static candidate map, NOT a proof that an entrypoint executes.
 * It records literal relative imports/require() and unresolved/dynamic imports.
 * Aliases, conditional runtime loading, generated imports and external packages
 * need separate build/runtime verification before moving or deleting source.
 */
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { extname, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set([".git", "node_modules", ".cache", ".next", "coverage", "dist"]);
const SOURCE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.js", "/index.mjs"];

function *walk(root, directory = root) {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink() || (item.isDirectory() && SKIP.has(item.name))) continue;
    const file = join(directory, item.name);
    if (item.isDirectory()) yield *walk(root, file);
    else if (item.isFile() && SOURCE_EXT.has(extname(file))) {
      yield relative(root, file).split(sep).join("/");
    }
  }
}

export function extractLiteralImports(source) {
  const imports = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?["']([^"'\r\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.push({ specifier: match[1], kind: "literal" });
  }
  // Dynamic expressions and import.meta.glob cannot be safely resolved from text.
  const dynamic = (source.match(/\bimport\s*\(\s*(?!["'])/g) || []).length;
  const glob = (source.match(/\bimport\.meta\.glob(?:Eager)?\s*\(/g) || []).length;
  return { imports: [...new Map(imports.map((i) => [i.specifier, i])).values()], dynamic, glob };
}

function normalize(p) { return p.split(sep).join("/"); }
export function resolveRelativeImport(importer, specifier, knownPaths) {
  if (!specifier.startsWith(".")) return null;
  const parent = dirname(importer);
  const base = normalize(resolve("/", parent, specifier)).replace(/^\//, "");
  for (const suffix of SUFFIXES) {
    if (knownPaths.has(base + suffix)) return base + suffix;
  }
  return null;
}

/**
 * Traverse only resolved literal relative edges from explicit build entrypoints.
 * A negative result is NOT proof that an import is unused: alias and dynamic
 * loaders, plugins, runtime evaluation and generated output are excluded.
 */
export function traceStaticEntrypoints([...edges, ...aliasEdges], entrypoints) {
  const outgoing = new Map();
  for (const { importer, target } of edges) {
    if (!outgoing.has(importer)) outgoing.set(importer, new Set());
    outgoing.get(importer).add(target);
  }
  const visited = new Set();
  const queue = [...entrypoints];
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    if (visited.has(path)) continue;
    visited.add(path);
    for (const target of outgoing.get(path) || []) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return [...visited].sort();
}

/**
 * Mirror the explicit Vite/tsconfig source aliases without resolving packages.
 * Additional aliases must be verified against the actual build configuration.
 */
export function resolveConfiguredAlias(specifier, knownPaths) {
  const aliases = [
    ["@/", "client/src/"],
    ["@shared/", "shared/"],
  ];
  for (const [prefix, root] of aliases) {
    if (!specifier.startsWith(prefix)) continue;
    const base = root + specifier.slice(prefix.length);
    for (const suffix of SUFFIXES) {
      if (knownPaths.has(base + suffix)) return base + suffix;
    }
  }
  return null;
}

export function auditImportOwnership(root = ROOT, options = {}) {
  const actual = realpathSync(resolve(root));
  const files = [...walk(actual)];
  const fileSet = new Set(files);
  const edges = [];
  const aliasEdges = [];
  const unresolvedAliases = [];
  const unresolved = [];
  const dynamicSites = [];
  for (const importer of files) {
    if (options.excludeDonors !== false && importer.startsWith("_TITAN_HANDOFF/")) continue;
    const source = readFileSync(join(actual, importer), "utf8");
    const parsed = extractLiteralImports(source);
    if (parsed.dynamic || parsed.glob) dynamicSites.push({ importer, dynamic: parsed.dynamic, glob: parsed.glob });
    for (const { specifier } of parsed.imports) {
      if (specifier.startsWith(".")) {
        const target = resolveRelativeImport(importer, specifier, fileSet);
        if (target) edges.push({ importer, target, specifier });
        else unresolved.push({ importer, specifier });
      } else if (specifier.startsWith("@/") || specifier.startsWith("@shared/")) {
        const target = resolveConfiguredAlias(specifier, fileSet);
        if (target) aliasEdges.push({ importer, target, specifier });
        else unresolvedAliases.push({ importer, specifier });
      }
    }
  }
  const inbound = new Map();
  for (const edge of [...edges, ...aliasEdges]) {
    const list = inbound.get(edge.target) || [];
    list.push(edge.importer);
    inbound.set(edge.target, list);
  }
  const selected = options.paths || [
    "server/integrations/titan-revenue/",
    "server/integrations/field-link/vendor/",
  ];
  const configuredEntrypoints = options.entrypoints || [
    "server/index.ts",
    "client/src/main.tsx",
    "scripts/build-server-deps.js",
  ];
  const entrypoints = configuredEntrypoints.filter((path) => fileSet.has(path));
  const missingEntrypoints = configuredEntrypoints.filter((path) => !fileSet.has(path));
  const staticReachable = new Set(traceStaticEntrypoints(edges, entrypoints));
  const ownership = files.filter((f) => selected.some((p) => f.startsWith(p))).map((path) => ({
    path,
    directImporters: (inbound.get(path) || []).sort(),
    staticEntrypointPathFound: staticReachable.has(path),
    sourceFile: true,
    live: "unverified",
  }));
  return {
    sourceFiles: files.length,
    resolvedRelativeEdges: edges.length,
    resolvedAliasEdges: aliasEdges.length,
    unresolvedRelativeEdges: unresolved.length,
    unresolvedAliasEdges: unresolvedAliases.length,
    dynamicSites,
    unresolved,
    unresolvedAliases,
    entrypoints,
    missingEntrypoints,
    staticReachableFiles: staticReachable.size,
    ownership,
    caveat: "Static literal imports cannot prove runtime reachability, safe deletion, dynamic resolution, or license permission.",
  };
}

function cli() {
  const args = process.argv.slice(2);
  if (args.some((x) => x !== "--json" && x !== "--help" && !x.startsWith("--root="))) {
    throw new Error("Usage: node scripts/audit-import-ownership.mjs [--root=/path] [--json]");
  }
  if (args.includes("--help")) {
    console.log("Usage: node scripts/audit-import-ownership.mjs [--root=/path] [--json]");
    return;
  }
  const root = args.find((x) => x.startsWith("--root="))?.slice(7) || ROOT;
  const result = auditImportOwnership(root);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Source files: ${result.sourceFiles}, relative import edges: ${result.resolvedRelativeEdges}, unresolved: ${result.unresolvedRelativeEdges}`);
    console.log(`Explicit entrypoints: ${result.entrypoints.join(", ") || "(none)"}; static paths: ${result.staticReachableFiles}; missing: ${result.missingEntrypoints.join(", ") || "(none)"}`);
    for (const x of result.ownership.filter((x) => x.directImporters.length)) {
      console.log(`${x.path} <- ${x.directImporters.join(", ")}`);
    }
    console.log(result.caveat);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { console.error(error); process.exitCode = 1; }
}
