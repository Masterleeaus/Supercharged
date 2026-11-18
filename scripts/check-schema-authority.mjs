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

/**
 * App-local DDL ratchet (issue #253, remaining item: runtime and script code that
 * runs CREATE/ALTER/DROP/TRUNCATE outside the Central chain).
 *
 * Each entry is the number of DDL lines that exist today. The baseline is not an
 * approval: every entry is an owner-decision item to move into migrations/ or
 * remove. The ratchet fails when a file gains DDL it did not have, when a new file
 * contains DDL, and when a count drops, so the baseline is lowered in the same PR.
 * Counts are per non-comment line that matches DDL_LINE.
 */
export const APP_LOCAL_DDL_BASELINE = {
  'scripts/add-leads-column.ts': 1,
  'scripts/apply-plugin-sql-direct.ts': 42,
  'scripts/check-inbox-delivery-state.mjs': 2,
  'scripts/check-inbox-outbox.mjs': 2,
  'scripts/check-inbox-rls.mjs': 2,
  'scripts/check-marketing-migration.mjs': 5,
  'scripts/fix-ve-sessions-columns.ts': 3,
  'scripts/tenant-postgres-prepare.mjs': 1,
  'scripts/update-db-prod.js': 1,
  'scripts/update-widgets-db.js': 5,
  'scripts/update-widgets-db.ts': 5,
  'server/demo-mode/index.ts': 1,
  'server/integrations/voltagent/vector-pg/pg-vector-store.ts': 4,
  'server/plugins/loader.ts': 1,
  'server/routes/plugin-installer.ts': 1,
  'server/routes/user-sip-gateways.routes.ts': 14,
  'server/scripts/update-db-prod.js': 1,
  'server/seed-all.ts': 74,
  'server/services/system-update-service.ts': 1,
};
const DDL_SCAN_DIRS = ['server/', 'scripts/', 'shared/', 'client/', 'plugins/', 'packages/'];
const DDL_EXT = /\.(mjs|cjs|js|ts|tsx)$/;
const DDL_LINE = /\b(create|alter|drop)\s+(table|index|schema|policy|type|extension)\b|\btruncate\s+table\b/i;

function countDdlLines(full) {
  const code = readFileSync(full, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  return code.filter((l) => DDL_LINE.test(l)).length;
}

export function checkAppLocalDdl(repoRoot = root, baseline = APP_LOCAL_DDL_BASELINE) {
  const failures = [];
  const rel = (p) => relative(repoRoot, p).split(sep).join('/');
  const seen = new Set();
  for (const file of listFiles(repoRoot)) {
    const path = rel(file);
    if (!DDL_EXT.test(path) || path.startsWith('tests/')) continue;
    if (path === 'scripts/check-schema-authority.mjs') continue;
    if (!DDL_SCAN_DIRS.some((d) => path.startsWith(d))) continue;
    seen.add(path);
    const count = countDdlLines(file);
    if (count === 0) continue;
    const max = baseline[path];
    if (max === undefined) {
      failures.push(`${path}: ${count} app-local DDL line(s) not in the baseline (#253); move them into migrations/ or get owner approval`);
    } else if (count > max) {
      failures.push(`${path}: app-local DDL grew from ${max} to ${count} (#253)`);
    } else if (count < max) {
      failures.push(`${path}: app-local DDL dropped to ${count} from ${max}; lower APP_LOCAL_DDL_BASELINE to ${count} (#253 ratchet)`);
    }
  }
  for (const path of Object.keys(baseline)) {
    if (seen.has(path)) continue;
    // A baseline entry for a file that no longer exists or has no DDL is stale only when the file is still present.
    try {
      if (countDdlLines(join(repoRoot, path)) === 0) {
        failures.push(`${path}: no app-local DDL left; remove its APP_LOCAL_DDL_BASELINE entry (#253 ratchet)`);
      }
    } catch {
      // File removed: the baseline entry is stale but harmless; ignore so fixture repos stay valid.
    }
  }
  return failures;
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
  failures.push(...checkAppLocalDdl(repoRoot));
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
  console.log('Schema authority check passed: drizzle-kit push is gated, and app-local DDL is within the ratchet baseline.');
}
