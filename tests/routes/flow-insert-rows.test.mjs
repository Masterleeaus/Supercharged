// Runtime checks for server/routes/flow-automation/insert-rows.ts.
// Covers: required input fields fail in Zod before any mapper or insert runs, server-owned keys
// in the request body are dropped, and mapped rows carry only the owner's ids.
// Column-level required checks are compile-time, in insert-rows.typecheck.ts.
// Run: node --test --experimental-transform-types tests/routes/flow-insert-rows.test.mjs
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowCreateInputSchema,
  webhookCreateInputSchema,
  flowInsertRow,
  webhookInsertRow,
} from '../../server/routes/flow-automation/insert-rows.ts';

const OWNER = { id: 'flow-server', userId: 'user-server', companyId: '11111111-1111-4111-8111-111111111111' };
const NODE = { id: 'n1', type: 'end', position: { x: 0, y: 0 }, data: { label: 'End', config: { type: 'end' } } };
const EDGE = { id: 'e1', source: 'n1', target: 'n2' };

describe('flow insert rows', () => {
  test('valid flow input maps to a row with owner ids and no extra keys', () => {
    const input = flowCreateInputSchema.parse({ name: 'Intake', nodes: [NODE], edges: [EDGE] });
    const row = flowInsertRow(input, OWNER);
    assert.equal(row.id, OWNER.id);
    assert.equal(row.userId, OWNER.userId);
    assert.equal(row.companyId, OWNER.companyId);
    assert.equal(row.name, 'Intake');
    assert.deepEqual(row.nodes, [NODE]);
    assert.deepEqual(Object.keys(row).sort(), [
      'agentId', 'companyId', 'createdAt', 'description', 'edges', 'executionConfig', 'id',
      'isActive', 'isTemplate', 'name', 'nodes', 'updatedAt', 'userId', 'voiceSettings',
    ].sort());
  });

  test('missing required flow fields fail validation before any mapper or insert', () => {
    assert.equal(flowCreateInputSchema.safeParse({ nodes: [NODE], edges: [EDGE] }).success, false);
    assert.equal(flowCreateInputSchema.safeParse({ name: 'x', edges: [EDGE] }).success, false);
    assert.equal(flowCreateInputSchema.safeParse({ name: 'x', nodes: [NODE] }).success, false);
  });

  test('flow graph containers must be arrays', () => {
    assert.equal(flowCreateInputSchema.safeParse({ name: 'x', nodes: {}, edges: [] }).success, false);
    assert.equal(flowCreateInputSchema.safeParse({ name: 'x', nodes: [], edges: 'nope' }).success, false);
  });

  test('server-owned keys in a flow request body are dropped, not used', () => {
    const parsed = flowCreateInputSchema.parse({
      name: 'x', nodes: [], edges: [],
      id: 'attacker-id', userId: 'attacker-user', companyId: 'attacker-company',
    });
    assert.equal('id' in parsed, false);
    assert.equal('userId' in parsed, false);
    assert.equal('companyId' in parsed, false);
    const row = flowInsertRow(parsed, OWNER);
    assert.equal(row.id, OWNER.id);
    assert.equal(row.userId, OWNER.userId);
    assert.equal(row.companyId, OWNER.companyId);
  });

  test('valid webhook input maps to a row; server-owned keys in the body are dropped', () => {
    const parsed = webhookCreateInputSchema.parse({
      name: 'Hook', url: 'https://example.com/h', secret: 'abc', events: ['call.ended'],
      id: 'attacker-id', userId: 'attacker-user', companyId: 'attacker-company',
    });
    assert.equal('userId' in parsed, false);
    const row = webhookInsertRow(parsed, OWNER);
    assert.equal(row.id, OWNER.id);
    assert.equal(row.userId, OWNER.userId);
    assert.equal(row.companyId, OWNER.companyId);
    assert.deepEqual(row.events, ['call.ended']);
  });

  test('missing required webhook fields fail validation before any insert', () => {
    assert.equal(webhookCreateInputSchema.safeParse({ name: 'h', secret: 's', events: [] }).success, false);
    assert.equal(webhookCreateInputSchema.safeParse({ name: 'h', url: 'u', events: [] }).success, false);
    assert.equal(webhookCreateInputSchema.safeParse({ name: 'h', url: 'u', secret: 's' }).success, false);
  });

  test('webhook events must be an array of strings', () => {
    assert.equal(webhookCreateInputSchema.safeParse({ name: 'h', url: 'u', secret: 's', events: [1] }).success, false);
  });
});
