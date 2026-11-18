import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('server/index.ts imports the pre-boot guard as its first import', () => {
  const source = readFileSync(`${root}server/index.ts`, 'utf8');
  const firstImport = source.match(/^import\s[^;]*;?$/m);
  assert.ok(firstImport, 'index.ts has an import');
  assert.match(firstImport[0], /from\s+["']\.\/pre-boot["']|^import\s+["']\.\/pre-boot["']/);
  assert.equal(source.includes('assertNoVoltOpsKeys()'), false, 'guard call moved out of index.ts');
});

test('pre-boot entry throws when a VoltOps key is set', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', `await import(${JSON.stringify(`${root}server/pre-boot.ts`)})`],
    { env: { ...process.env, VOLTAGENT_SECRET_KEY: 'sk_test', VOLTAGENT_PUBLIC_KEY: '' }, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VoltOps is disabled.*VOLTAGENT_SECRET_KEY/);
});

test('pre-boot entry loads cleanly when no VoltOps key is set', () => {
  const env = { ...process.env };
  delete env.VOLTAGENT_PUBLIC_KEY;
  delete env.VOLTAGENT_SECRET_KEY;
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', `await import(${JSON.stringify(`${root}server/pre-boot.ts`)})`],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
