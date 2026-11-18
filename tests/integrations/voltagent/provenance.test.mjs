// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
// Provenance tests for issue #395: attribution docs, NOTICE coverage, file headers and the verbatim scanner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TARGET,
  findVerbatimLines,
  listSourceFiles,
  longLines,
} from '../../../scripts/check-voltagent-provenance.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-voltagent-provenance.mjs');
const targetDir = path.join(repoRoot, DEFAULT_TARGET);
const COPIED = 'const sqlBuilder = buildFilterClauseForVectorStoreQueryWithTenantScope(input);';

test('findVerbatimLines flags a copied long line and ignores short or different lines', () => {
  const reference = [`export function f() {\n  ${COPIED}\n  return 1;\n}\n`];
  assert.deepEqual(findVerbatimLines(reference, `x\n    ${COPIED}\n`), [COPIED]);
  assert.deepEqual(findVerbatimLines(reference, 'const a = 1;\nconst b = 2;\n'), []);
  assert.equal(longLines('short\n' + 'x'.repeat(49)).length, 0);
});

test('the scanner exits 1 when a target file copies a reference line, and 0 when it does not', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const reference = path.join(root, 'mastra');
  const target = path.join(root, 'target');
  mkdirSync(path.join(reference, 'packages', 'x'), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(reference, 'packages', 'x', 'index.ts'), `${COPIED}\n`);

  writeFileSync(path.join(target, 'copied.ts'), `// header\n${COPIED}\n`);
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, reference, target], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 1 && /1 verbatim line\(s\) found/.test(err.stdout),
  );

  writeFileSync(path.join(target, 'copied.ts'), 'export const original = 1;\n');
  const out = execFileSync(process.execPath, [scriptPath, reference, target], { encoding: 'utf8' });
  assert.match(out, /0 verbatim line\(s\) found/);
});

test('the scanner refuses a missing reference checkout with exit code 2', () => {
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, path.join(os.tmpdir(), 'no-such-mastra-checkout-395')], { stdio: 'pipe' }),
    (err) => err.status === 2,
  );
});

test('the attribution doc exists and points to the scanner and the NOTICE', () => {
  const doc = readFileSync(path.join(repoRoot, 'docs', 'mastra-attribution.md'), 'utf8');
  assert.match(doc, /scripts\/check-voltagent-provenance\.mjs/);
  assert.match(doc, /server\/integrations\/voltagent\/NOTICE\.md/);
  assert.match(doc, /b9d38c73982210c6564ee8a33d992a238e29a20b/);
});

test('every VoltAgent source file is listed in the NOTICE', () => {
  const notice = readFileSync(path.join(targetDir, 'NOTICE.md'), 'utf8');
  const files = listSourceFiles(targetDir).map((file) => path.relative(targetDir, file));
  assert.ok(files.length >= 17, `expected at least 17 source files, found ${files.length}`);
  for (const rel of files) {
    assert.ok(notice.includes(`- ${rel}`), `NOTICE.md does not list ${rel}`);
  }
});

test('every VoltAgent source file carries a licence header', () => {
  for (const file of listSourceFiles(targetDir)) {
    const head = readFileSync(file, 'utf8').split('\n').slice(0, 25).join('\n');
    assert.match(head, /Licence:/, `${path.relative(repoRoot, file)} has no Licence line in its header`);
  }
});

test('no VoltAgent source file names an enterprise path', () => {
  for (const file of listSourceFiles(targetDir)) {
    assert.equal(/\/ee\//.test(file), false, `${file} is under an ee/ directory`);
  }
});
