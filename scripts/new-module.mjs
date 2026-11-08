#!/usr/bin/env node
/**
 * Generate a new server module or plugin from the templates.
 *
 *   node scripts/new-module.mjs <name>            -> server/modules/<name>/   (from server/modules/_template)
 *   node scripts/new-module.mjs <name> --plugin   -> plugins/<name>/          (from docs/templates/plugin)
 *   Options: --root <dir>  operate on another repository root (used by tests).
 *
 * Name: lowercase kebab-case, e.g. my-thing. Node built-ins only.
 * Output is built in memory and checked for leftover tokens before anything is written.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(["template", "_template"]);
const TOKEN_RE = /\{\{(name|title|pascal|camel|upper)\}\}/g;
const LEFTOVER_RE = /\{\{\s*[A-Za-z_]\w*\s*\}\}/;
const TEMPLATE_PREFIX = "template-";

export function deriveTokens(name) {
  const parts = name.split("-");
  const pascal = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return {
    name,
    title: parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" "),
    pascal,
    camel: pascal[0].toLowerCase() + pascal.slice(1),
    upper: name.toUpperCase().replace(/-/g, "_"),
  };
}

export function validateName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 50) {
    throw new Error("name must be 1-50 characters");
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid name "${name}": use lowercase letters, digits and single hyphens, starting with a letter`);
  }
  if (RESERVED.has(name)) {
    throw new Error(`"${name}" is reserved for the template itself`);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

/**
 * Build the generated file set in memory: Map<relativePath, content>.
 * Throws if any placeholder token is left behind.
 */
export function renderTemplate(srcDir, name) {
  const tokens = deriveTokens(name);
  const files = new Map();
  for (const rel of listFiles(srcDir)) {
    const dirPart = path.dirname(rel);
    let base = path.basename(rel);
    if (base.startsWith(TEMPLATE_PREFIX)) base = name + base.slice("template".length);
    const outRel = dirPart === "." ? base : path.join(dirPart, base);
    const raw = fs.readFileSync(path.join(srcDir, rel), "utf8");
    const content = raw.replace(TOKEN_RE, (_, key) => tokens[key]);
    if (LEFTOVER_RE.test(content)) {
      throw new Error(`leftover placeholder token in ${outRel}`);
    }
    files.set(outRel, content);
  }
  return files;
}

export function generate({ name, plugin = false, root = DEFAULT_ROOT }) {
  validateName(name);
  const srcDir = plugin
    ? path.join(root, "docs", "templates", "plugin")
    : path.join(root, "server", "modules", "_template");
  const destDir = plugin
    ? path.join(root, "plugins", name)
    : path.join(root, "server", "modules", name);

  if (!fs.existsSync(srcDir)) throw new Error(`template folder not found: ${srcDir}`);
  if (fs.existsSync(destDir)) throw new Error(`destination already exists: ${destDir}`);

  const files = renderTemplate(srcDir, name);
  for (const [rel, content] of files) {
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: "wx" });
  }
  return { destDir, files: [...files.keys()] };
}

function main(argv) {
  const args = argv.slice(2);
  const plugin = args.includes("--plugin");
  const rootIdx = args.indexOf("--root");
  if (rootIdx >= 0 && (!args[rootIdx + 1] || args[rootIdx + 1].startsWith("--"))) {
    console.error("new-module: --root needs a directory");
    return 2;
  }
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : DEFAULT_ROOT;
  const positional = args.filter((a, i) => !a.startsWith("--") && (rootIdx < 0 || i !== rootIdx + 1));
  if (positional.length !== 1) {
    console.error("usage: node scripts/new-module.mjs <name> [--plugin] [--root <dir>]");
    return 2;
  }
  try {
    const { destDir, files } = generate({ name: positional[0], plugin, root });
    console.log(`Created ${destDir}`);
    for (const f of files) console.log(`  ${f}`);
    return 0;
  } catch (err) {
    console.error(`new-module: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
