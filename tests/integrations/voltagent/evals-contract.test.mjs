/**
 * W8 (#391): contract tests for the VoltAgent evals adapter, using the adapter on main as the spec.
 * The evaluator in server/services/ai-runtime/evaluator.ts stays the source of scoring rules.
 * No network, no database, no @voltagent/scorers.
 * Run: node --test --experimental-strip-types tests/integrations/voltagent/evals-contract.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvalAdapter, toScorerResult } from '../../../server/integrations/voltagent/evals/adapter.ts';

const score = (composite, extra = {}) => ({
  composite_score: composite,
  task_completion_rate: 1,
  tool_accuracy: 1,
  hallucination_flag: 0,
  response_latency_ms: 42,
  agent_name: 'booking-agent',
  session_id: 'session-1',
  ...extra,
});

test('W8 score mapping: 0 maps to 0 and 100 maps to 1', () => {
  assert.equal(toScorerResult(score(0)).score, 0);
  assert.equal(toScorerResult(score(100)).score, 1);
});

test('W8 score mapping rounds to four decimal places', () => {
  assert.equal(toScorerResult(score(33.33333)).score, 0.3333);
  assert.equal(toScorerResult(score(66.66666)).score, 0.6667);
});

test('W8 metadata carries the hallucination flag as 0 or 1 and the latency unchanged', () => {
  const r = toScorerResult(score(80, { hallucination_flag: 1, response_latency_ms: 1234 }));
  assert.equal(r.metadata.hallucination_flag, 1);
  assert.equal(r.metadata.response_latency_ms, 1234);
});

test('W8 disabled adapter is skipped with a reason and reports enabled false', async () => {
  const adapter = createEvalAdapter({ enabled: false });
  assert.equal(adapter.enabled, false);
  assert.deepEqual(await adapter.evaluate({ companyId: 'co-1', sessionId: 'session-1', agentName: 'a', response: 'x' }), {
    skipped: true,
    reason: 'evals_disabled',
  });
});

test('W8 enabled flag must be exactly true (a truthy string does not enable evals)', () => {
  assert.equal(createEvalAdapter({ enabled: 'true' }).enabled, false);
  assert.equal(createEvalAdapter({ enabled: 1 }).enabled, false);
  assert.equal(createEvalAdapter({ enabled: true }).enabled, true);
});
