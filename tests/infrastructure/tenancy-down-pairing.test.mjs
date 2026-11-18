// Issue #251: every tenancy up migration (0014 to 0027) has a down file, so each step can be reversed.
// Static check: reads file names only, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const files = readdirSync(MIGRATIONS_DIR);

const tenancyUps = files
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .filter((f) => {
    const n = Number(f.slice(0, 4));
    return n >= 14 && n <= 27;
  });

test('tenancy range 0014 to 0027 is present', () => {
  assert.ok(tenancyUps.some((f) => f.startsWith('0014_')));
  assert.ok(tenancyUps.some((f) => f.startsWith('0027_')));
});

for (const up of tenancyUps) {
  test(`${up} has a down file`, () => {
    const down = up.replace(/\.sql$/, '.down.sql');
    assert.ok(existsSync(new URL(down, MIGRATIONS_DIR)), `missing ${down}`);
  });
}

test('the desk_app role migration (0018a) keeps its written down plan', () => {
  const text = readFileSync(new URL('0018a_desk_app_role.down.sql', MIGRATIONS_DIR), 'utf8');
  assert.match(text, /Written plan: the role itself is NOT dropped/);
  const sql = text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(sql, /DROP ROLE/i);
});

