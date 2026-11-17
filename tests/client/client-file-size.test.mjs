import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../client/src', import.meta.url));
const LIMIT_BYTES = 60 * 1000;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('no client source file is over the 60 KB limit (issue #129)', () => {
  const oversized = walk(root)
    .map((file) => ({ file: relative(root, file), size: statSync(file).size }))
    .filter((f) => f.size > LIMIT_BYTES);
  assert.deepEqual(oversized, []);
});

test('PlivoSettings is split into section components under plivo/', () => {
  const main = statSync(join(root, 'components/admin/PlivoSettings.tsx')).size;
  assert.ok(main < LIMIT_BYTES);
  for (const name of ['PlivoCredentialsSection', 'PhonePricingSection', 'PhoneNumbersSection']) {
    assert.ok(statSync(join(root, 'components/admin/plivo', `${name}.tsx`)).size < LIMIT_BYTES);
  }
});
