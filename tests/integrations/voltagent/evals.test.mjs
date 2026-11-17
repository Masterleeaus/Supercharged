import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvalAdapter, toScorerResult } from '../../../server/integrations/voltagent/evals/adapter.ts';

const base = {
  companyId: 'co-1',
  agentName: 'booking-agent',
  sessionId: 'sess-1',
  response: { result: 'Booked for Tuesday', tool_calls: ['calendar.create'] },
  expectedOutcome: { expected_keys: ['result'], expected_tools: ['calendar.create'], forbidden_strings: ['as an ai'] },
  latencyMs: 120,
};

test('disabled adapter skips and never writes to the sink', async () => {
  const written = [];
  const adapter = createEvalAdapter({ enabled: false, sink: (s) => written.push(s) });
  const out = await adapter.evaluate(base);
  assert.deepEqual(out, { skipped: true, reason: 'evals_disabled' });
  assert.equal(written.length, 0);
});

test('an unset enabled option is treated as disabled', async () => {
  const adapter = createEvalAdapter({});
  assert.equal(adapter.enabled, false);
  assert.equal((await adapter.evaluate(base)).skipped, true);
});

test('enabled adapter scores through the ai-runtime evaluator and calls the sink', async () => {
  const written = [];
  const adapter = createEvalAdapter({ enabled: true, sink: (s) => written.push(s) });
  const out = await adapter.evaluate(base);
  assert.equal(out.skipped, false);
  assert.equal(out.score.company_id, 'co-1');
  assert.equal(out.score.tool_accuracy, 100);
  assert.equal(out.score.hallucination_flag, 0);
  assert.equal(written.length, 1);
  assert.equal(out.result.score, out.score.composite_score / 100);
});

test('missing companyId is rejected even when evals are enabled', async () => {
  const adapter = createEvalAdapter({ enabled: true });
  await assert.rejects(adapter.evaluate({ ...base, companyId: '' }));
});

test('forbidden text flags a hallucination in the scorer metadata', async () => {
  const adapter = createEvalAdapter({ enabled: true });
  const out = await adapter.evaluate({ ...base, response: { result: 'As an AI I cannot book' } });
  assert.equal(out.result.metadata.hallucination_flag, 1);
});

test('toScorerResult maps the composite to 0 to 1 and keeps metadata', () => {
  const r = toScorerResult({
    company_id: 'c', agent_name: 'a', session_id: 's', task_completion_rate: 80,
    hallucination_flag: 0, tool_accuracy: 50, response_latency_ms: 5, composite_score: 73.5, response_snapshot: '{}',
  });
  assert.equal(r.score, 0.735);
  assert.equal(r.metadata.tool_accuracy, 50);
  assert.equal(r.metadata.agent_name, 'a');
});
