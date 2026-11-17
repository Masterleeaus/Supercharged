#!/usr/bin/env node
/**
 * Issue #253 drift gate (static). Fails when any repo file can change shared
 * schema outside the Central migration chain.
 *
 * Rules:
 *  1. Only scripts/db-push-non-interactive.mjs may mention `drizzle-kit push`.
 *  2. That wrapper must refuse to run unless ALLOW_DB_PUSH=1 is set.
 *  3. package.json must not map any script to a direct `drizzle-kit push`.
 *  4. No workflow may call `drizzle-kit push` or the db:push script.
 *
 * Usage: node scripts/check-schema-authority.mjs   (exit 0 pass, 1 fail)
 * It reads files only and never connects to a database.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = 'scripts/db-push-non-interactive.mjs';
const PUSH = /drizzle-kit\s+push\b/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'docs', '_TITAN_HANDOFF', 'attached_assets']);
const SCANNED_EXT = /\.(mjs|cjs|js|ts|tsx|sh|yml|yaml|json)$/;

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else if (SCANNED_EXT.test(name) && name !== 'package-lock.json') out.push(full);
  }
  return out;
}

export function checkSchemaAuthority(repoRoot = root) {
  const failures = [];
  const rel = (p) => relative(repoRoot, p).split(sep).join('/');
  const files = listFiles(repoRoot);
  for (const file of files) {
    const path = rel(file);
    if (path.startsWith('tests/')) continue; // tests may name the command in assertions
    const text = readFileSync(file, 'utf8');
    // Comments may explain the history; only executable lines count.
    const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (!PUSH.test(code)) continue;
    if (path === WRAPPER) continue;
    if (path === 'scripts/check-schema-authority.mjs') continue;
    if (path.startsWith('.github/workflows/')) {
      failures.push(`${path}: workflow calls drizzle-kit push (rule 4)`);
    } else if (path === 'package.json') {
      failures.push(`${path}: a script runs drizzle-kit push directly (rule 3)`);
    } else if (path.startsWith('server/') || path.startsWith('client/') || path.startsWith('shared/')) {
      failures.push(`${path}: runtime code references drizzle-kit push (rule 1)`);
    } else if (path.startsWith('scripts/') || path.endsWith('.sh')) {
      failures.push(`${path}: script runs drizzle-kit push outside the gated wrapper (rule 1)`);
    }
  }
  const wrapperPath = join(repoRoot, WRAPPER);
  const wrapper = readFileSync(wrapperPath, 'utf8');
  if (!/process\.env\.ALLOW_DB_PUSH\s*!==\s*"1"/.test(wrapper)) {
    failures.push(`${WRAPPER}: missing the ALLOW_DB_PUSH=1 refusal gate (rule 2)`);
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (name === 'db:push') {
      if (cmd !== `node ${WRAPPER}`) failures.push(`package.json: db:push must run only ${WRAPPER} (rule 3)`);
    } else if (PUSH.test(cmd)) {
      failures.push(`package.json: script "${name}" runs drizzle-kit push directly (rule 3)`);
    }
  }
  return failures;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const failures = checkSchemaAuthority();
  if (failures.length) {
    console.error('Schema authority check failed (issue #253):');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('Schema authority check passed: drizzle-kit push is gated and not referenced elsewhere.');
}
