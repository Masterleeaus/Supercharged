import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = fs.readFileSync(path.join(root, 'docs/generated/SUPERCHARGED-CANONICAL-TREE-MAP.md'), 'utf8');

/** Returns the table rows under the "Canonical path per capability" heading. */
function capabilityRows() {
  const start = doc.indexOf('## Canonical path per capability');
  assert.ok(start >= 0, 'capability section exists');
  const section = doc.slice(start).split('\n## ')[0];
  return section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Capability') && !line.startsWith('| ---'));
}

test('every capability row names at least one canonical path', () => {
  const rows = capabilityRows();
  assert.ok(rows.length >= 10, `expected at least 10 capability rows, found ${rows.length}`);
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    assert.ok(cells[2] && cells[2].includes('`'), `row has a canonical path: ${row}`);
  }
});

test('every canonical path in the capability table exists in the repo', () => {
  const missing = [];
  for (const row of capabilityRows()) {
    const canonicalCell = row.split('|')[2] ?? '';
    for (const match of canonicalCell.matchAll(/`([^`]+)`/g)) {
      const rel = match[1];
      if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
    }
  }
  assert.deepEqual(missing, [], `missing canonical paths: ${missing.join(', ')}`);
});

test('the map keeps donor and handoff material and does not claim deletions', () => {
  assert.match(doc, /_TITAN_HANDOFF\//);
  assert.match(doc, /Do not delete until/);
  assert.match(doc, /No code was moved or deleted/);
});

test('the map states that runtime readiness is not claimed', () => {
  assert.match(doc, /Readiness is not claimed here/);
});
