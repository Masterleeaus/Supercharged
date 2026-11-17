/**
 * Issue #252 ratchet: no new server file may reach the database without withTenant().
 *
 * A file "reaches the database" when it imports the db handle or a pg pool. It "uses withTenant"
 * when its text mentions withTenant or withTenantTransaction. Files on the baseline are known
 * bypasses that still need converting; the test fails only on files that are not on the baseline.
 * Shrinking the baseline is welcome; regenerate it with the script in the header of the baseline file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DB_IMPORT = /import .*\b(db|pool)\b.* from|from ['"][./]*(server\/)?db['"]|getDb\(|new Pool\(|pg\.Pool/;

export function listBypassFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'archive' || name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.includes('.test.') || name.includes('DRAFT')) continue;
      const src = readFileSync(full, 'utf8');
      if (!src.split('\n').some((line) => DB_IMPORT.test(line))) continue;
      if (/withTenant/.test(src)) continue;
      out.push(relative(root, full));
    }
  };
  walk(join(root, 'server'));
  return out.sort();
}

test('no new server file reaches the database without withTenant()', () => {
  const baseline = new Set(JSON.parse(readFileSync(new URL('./withtenant-bypass-baseline.json', import.meta.url), 'utf8')));
  const current = listBypassFiles();
  const added = current.filter((f) => !baseline.has(f));
  assert.deepEqual(added, [], `new database paths that bypass withTenant(): ${added.join(', ')}`);
});
