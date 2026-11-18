// Drift guard for the required per-area typecheck matrix (issue #122).
// Every area in scripts/typecheck-area.mjs that has files must be a gating job in
// .github/workflows/pr-checks.yml (job "typecheck-required"), and the matrix must not list an area twice
// or list an area the script does not know. An area with no files is the only allowed exception.
// Run: node --test tests/infrastructure/typecheck-area-matrix.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AREAS, areaFiles} from '../../scripts/typecheck-area.mjs';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/pr-checks.yml', import.meta.url));

// Reads the "area:" list of the typecheck-required job. The list is plain "- <area>" lines at a fixed indent.
function matrixAreas() {
  const lines = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^  typecheck-required:\s*$/.test(l));
  assert.ok(start >= 0, 'typecheck-required job is missing from pr-checks.yml');
  const areaIdx = lines.findIndex((l, i) => i > start && /^ {8}area:\s*$/.test(l));
  assert.ok(areaIdx > start, 'typecheck-required job has no area matrix');
  const areas = [];
  for (let i = areaIdx + 1; i < lines.length; i++) {
    const m = /^ {10}- (\S+)\s*$/.exec(lines[i]);
    if (!m) break;
    areas.push(m[1]);
  }
  return areas;
}

test('the required matrix lists each area once', () => {
  const areas = matrixAreas();
  assert.ok(areas.length > 0, 'matrix is empty');
  assert.equal(new Set(areas).size, areas.length, `duplicate area in matrix: ${areas.join(', ')}`);
});

test('every matrix entry is an area the script knows', () => {
  for (const area of matrixAreas()) {
    assert.ok(Object.hasOwn(AREAS, area), `matrix area "${area}" is not defined in scripts/typecheck-area.mjs`);
  }
});

test('every non-empty area is a gating job; only empty areas may be left out', () => {
  const matrix = new Set(matrixAreas());
  const missing = Object.keys(AREAS).filter((area) => !matrix.has(area) && areaFiles(area).length > 0);
  assert.deepEqual(missing, [], `areas with files but not in the required matrix: ${missing.join(', ')}`);
});

test('server/types stays out of the matrix because it has no files to check', () => {
  assert.equal(areaFiles('server/types').length, 0);
  assert.ok(!matrixAreas().includes('server/types'));
});
