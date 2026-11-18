// Keeps the required per-area typecheck matrix in .github/workflows/pr-checks.yml in step with
// the area map in scripts/typecheck-area.mjs. Issue #122.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, areaFiles } from '../../scripts/typecheck-area.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(root, '.github/workflows/pr-checks.yml'), 'utf8');
const jobStart = workflow.indexOf('  typecheck-required:');
const jobEnd = workflow.indexOf('  typecheck:\n', jobStart);
assert.ok(jobStart > 0 && jobEnd > jobStart, 'typecheck-required job not found');
const job = workflow.slice(jobStart, jobEnd);
const matrixBlock = job.slice(job.indexOf('matrix:'), job.indexOf('steps:'));
const matrix = [...matrixBlock.matchAll(/^\s+- (\S+)\s*$/gm)].map((m) => m[1]);

test('required typecheck matrix lists at least one area and no duplicates', () => {
  assert.ok(matrix.length > 0, 'matrix is empty');
  assert.equal(new Set(matrix).size, matrix.length, 'matrix has duplicate areas');
});

test('every required matrix area is a known area in scripts/typecheck-area.mjs', () => {
  for (const area of matrix) {
    assert.ok(Object.prototype.hasOwnProperty.call(AREAS, area), `unknown matrix area: ${area}`);
  }
});

test('every required matrix area resolves to at least one file on disk', () => {
  for (const area of matrix) {
    assert.ok(areaFiles(area).length > 0, `area has no files: ${area}`);
  }
});

test('every area in the area map is gated by the required matrix (no silent gaps)', () => {
  const ungated = Object.keys(AREAS).filter((area) => !matrix.includes(area));
  assert.deepEqual(ungated, [], `areas defined but not gated: ${ungated.join(', ')}`);
});

test('every area path in the area map exists on disk', () => {
  for (const [area, spec] of Object.entries(AREAS)) {
    const path = join(root, spec.endsWith('/') ? spec.slice(0, -1) : spec);
    assert.ok(existsSync(path), `area path missing for ${area}: ${spec}`);
  }
});
