import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const runtimePath = path.join(root, 'runtime/workforce-runtime-background.mjs');

async function source(){ return readFile(runtimePath, 'utf8'); }

test('workforce runtime preserves existing control and investigation handlers', async () => {
  const text = await source();
  assert.match(text, /TITAN_WORKFORCE_CONTROL_INTENT/);
  assert.match(text, /TITAN_INVESTIGATION_PARTICIPATION/);
  assert.match(text, /TITAN_WORKFORCE_RUNTIME/);
});

test('workforce runtime imports canonical P1-007 authority boundary helpers', async () => {
  const text = await source();
  assert.match(text, /evaluateWorkerAuthorityDecision/);
  assert.match(text, /prepareGovernedCommandEnvelope/);
  assert.match(text, /assertAuthoritativeExecutionReceipt/);
  assert.match(text, /assertPostActionVerification/);
  assert.match(text, /\.\.\/titan-runtime\/authority\/index\.mjs/);
});

test('workforce runtime exposes authority evaluation and command preparation messages', async () => {
  const text = await source();
  assert.match(text, /TITAN_WORKFORCE_AUTHORITY_EVALUATE/);
  assert.match(text, /TITAN_WORKFORCE_COMMAND_PREPARE/);
  assert.match(text, /TITAN_WORKFORCE_RECEIPT_VERIFY/);
});

test('command preparation remains proposal-only and does not become a direct domain mutation path', async () => {
  const text = await source();
  const start = text.indexOf("TITAN_WORKFORCE_COMMAND_PREPARE");
  assert.notEqual(start, -1);
  const next = text.indexOf("TITAN_WORKFORCE_RECEIPT_VERIFY", start);
  const branch = text.slice(start, next === -1 ? undefined : next);
  assert.doesNotMatch(branch, /database\.(putRecord|deleteRecord|transaction)/);
  assert.match(text, /authority_effect:false/);
});
