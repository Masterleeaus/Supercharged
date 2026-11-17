import assert from 'node:assert/strict';
import test from 'node:test';
import { readVoltAgentFlags, voltAgentFlags } from '../../../server/integrations/voltagent/flags.ts';

const FLAG_NAMES = [
  'VOLTAGENT_AGENTS_ENABLED',
  'VOLTAGENT_WORKFLOWS_ENABLED',
  'VOLTAGENT_RAG_ENABLED',
  'VOLTAGENT_PGVECTOR_ENABLED',
  'VOLTAGENT_RERANK_ENABLED',
  'VOLTAGENT_TELEMETRY_ENABLED',
  'VOLTAGENT_EVALS_ENABLED',
  'VOLTAGENT_MCP_ENABLED',
  'VOLTAGENT_VOICE_ENABLED',
];

test('every flag defaults to false when unset', () => {
  const flags = readVoltAgentFlags({});
  for (const value of Object.values(flags)) {
    assert.equal(value, false);
  }
  assert.equal(Object.keys(flags).length, FLAG_NAMES.length);
});

test('each flag turns on only for the exact string "true"', () => {
  const flags = readVoltAgentFlags({ VOLTAGENT_RAG_ENABLED: 'true', VOLTAGENT_MCP_ENABLED: '1' });
  assert.equal(flags.ragEnabled, true);
  assert.equal(flags.mcpEnabled, false);
});

test('the exported flag object is frozen', () => {
  assert.equal(Object.isFrozen(voltAgentFlags), true);
  assert.equal(Object.isFrozen(readVoltAgentFlags({})), true);
});
