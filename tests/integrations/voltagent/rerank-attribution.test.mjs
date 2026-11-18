// Licence: original TitanZero test code. Reads a docs file only. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const doc = readFileSync(path.join(root, 'docs/mastra-attribution.md'), 'utf8');

test('attribution page names the Mastra file and the exact commit it was read at', () => {
  assert.match(doc, /packages\/rag\/src\/rerank\/relevance\/cohere\/index\.ts/);
  assert.match(doc, /b9d38c73982210c6564ee8a33d992a238e29a20b/);
});

test('attribution page records the Apache-2.0 licence and copyright holder', () => {
  assert.match(doc, /Apache License 2\.0/);
  assert.match(doc, /Copyright \(c\) 2025 Kepler Software, Inc\./);
});

test('attribution page names the reranker module and its tests', () => {
  assert.match(doc, /server\/integrations\/voltagent\/rerank\/cohere-reranker\.ts/);
  assert.match(doc, /tests\/integrations\/voltagent\/rerank\.test\.mjs/);
});

test('attribution page states that no Mastra source is copied verbatim and the live API is not called', () => {
  assert.match(doc, /No Mastra source is copied verbatim/);
  assert.match(doc, /The live Cohere API is not called/);
});
