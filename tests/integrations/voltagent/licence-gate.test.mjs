import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLicence } from '../../../scripts/check-voltagent-licence.mjs';

// Built at runtime so this file does not itself contain a Mastra import.
const MASTRA_PKG = '@' + 'mastra/';

const NOTICE_DOC = [
  '# Mastra attribution',
  'Copyright (c) 2025 Kepler Software, Inc. Apache-2.0 files keep their original headers.',
].join('\n');

function audit(tree) {
  const files = Object.keys(tree);
  return auditLicence({ files, readFile: (file) => tree[file] });
}

test('a clean tree passes with no problems', () => {
  const result = audit({
    'server/integrations/voltagent/flags.ts': "import { x } from './y.ts';\n",
    'tests/integrations/voltagent/flags.test.mjs': "import test from 'node:test';\n",
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 2);
  assert.equal(result.codeChecked, 2);
});

test('an enterprise /ee/ path fails anywhere in the repo, not only under integrations', () => {
  const result = audit({
    'source/mastra-x/packages/core/src/ee/license.ts': 'export const x = 1;\n',
  });
  assert.deepEqual(result.problems, [
    'enterprise path: source/mastra-x/packages/core/src/ee/license.ts',
  ]);
});

test('a path that only contains "ee" as part of a word is not an enterprise path', () => {
  const result = audit({ 'server/need/fee.ts': 'export const x = 1;\n' });
  assert.deepEqual(result.problems, []);
});

test('an @mastra import fails in integrations code', () => {
  const result = audit({
    'server/integrations/voltagent/agents/bridge.ts': `import { Agent } from '${MASTRA_PKG}core';\n`,
  });
  assert.deepEqual(result.problems, [
    '@mastra import: server/integrations/voltagent/agents/bridge.ts',
  ]);
});

test('an @mastra require or dynamic import fails outside integrations too', () => {
  const result = audit({
    'client/src/x.tsx': `const m = require('${MASTRA_PKG}core');\n`,
    'server/routes/y.ts': `const m = await import('${MASTRA_PKG}rag');\n`,
  });
  assert.equal(result.problems.length, 2);
  assert.ok(result.problems.includes('@mastra import: client/src/x.tsx'));
  assert.ok(result.problems.includes('@mastra import: server/routes/y.ts'));
});

test('a text mention of Mastra in a comment or doc is not an import', () => {
  const result = audit({
    'server/integrations/voltagent/rerank/cohere-reranker.ts': "// Port of Mastra's reranker, no code copied.\n",
    'STATUS.md': `import { x } from '${MASTRA_PKG}core'; // doc example only\n`,
  });
  assert.deepEqual(result.problems, []);
});

test('the Mastra snapshot without an attribution doc fails', () => {
  const result = audit({
    'source/mastra-apache-only/README.md': '# Mastra\n',
  });
  assert.deepEqual(result.problems, ['missing attribution doc: docs/mastra-attribution.md']);
});

test('an attribution doc without the copyright notice fails', () => {
  const result = audit({
    'source/mastra-apache-only/README.md': '# Mastra\n',
    'docs/mastra-attribution.md': '# Mastra attribution\nApache-2.0\n',
  });
  assert.deepEqual(result.problems, [
    'attribution doc lacks copyright notice: docs/mastra-attribution.md',
  ]);
});

test('an attribution doc without the Apache-2.0 reference fails', () => {
  const result = audit({
    'source/mastra-apache-only/README.md': '# Mastra\n',
    'docs/mastra-attribution.md': 'Copyright (c) 2025 Kepler Software, Inc.\n',
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /lacks Apache-2\.0 licence reference/);
});

test('the snapshot with a complete attribution doc passes', () => {
  const result = audit({
    'source/mastra-apache-only/README.md': '# Mastra\n',
    'docs/mastra-attribution.md': NOTICE_DOC,
  });
  assert.deepEqual(result.problems, []);
});
