import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const entry = readFileSync(new URL('../../server/index.ts', import.meta.url), 'utf8');
const preboot = readFileSync(new URL('../../server/preboot.ts', import.meta.url), 'utf8');

const importLines = entry
  .split('\n')
  .filter((line) => /^\s*import\b/.test(line) || /^\s*export\s+.*\sfrom\s/.test(line));

test('server entry imports the pre-boot guard as its first import', () => {
  assert.match(importLines[0], /^import "\.\/preboot";$/);
});

test('entry no longer calls the guard after its imports', () => {
  assert.doesNotMatch(entry, /assertNoVoltOpsKeys\(\)/);
});

test('pre-boot module has no dependencies other than the guard', () => {
  const imports = preboot.split('\n').filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(imports, ["import { assertNoVoltOpsKeys } from './integrations/voltagent/guard.ts';"]);
  assert.match(preboot, /^assertNoVoltOpsKeys\(\);$/m);
});

test('server entry refuses to boot when a VoltOps key is set, before loading workstreams', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, VOLTAGENT_SECRET_KEY: 'sk_test_do_not_use' },
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VoltOps is disabled for this deployment\. Unset VOLTAGENT_SECRET_KEY/);
  assert.doesNotMatch(result.stderr + result.stdout, /Platform Initialized/);
});
