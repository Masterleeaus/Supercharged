import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskCompletionScorer,
  hallucinationScorer,
  toolAccuracyScorer,
  runLocalScorers,
  LOCAL_SCORERS,
} from '../../../server/integrations/voltagent/evals/scorers.ts';
import { evaluateResponse } from '../../../server/services/ai-runtime/evaluator.ts';

test('local scorers are registered under stable names', () => {
  assert.deepEqual(
    LOCAL_SCORERS.map((s) => s({ response: { result: 'x' } }).name),
    ['task_completion', 'hallucination_free', 'tool_accuracy'],
  );
});

test('task completion: empty response scores 0', () => {
  const r = taskCompletionScorer({ response: {} });
  assert.equal(r.score, 0);
  assert.equal(r.metadata.task_completion_rate, 0);
});

test('task completion: result key plus all expected keys scores 1', () => {
  const r = taskCompletionScorer({
    response: { result: 'ok', date: '2026-01-01' },
    expectedOutcome: { expected_keys: ['date'] },
  });
  assert.equal(r.score, 1);
});

test('task completion: a missing expected key lowers the score pro rata', () => {
  const r = taskCompletionScorer({
    response: { result: 'ok' },
    expectedOutcome: { expected_keys: ['date', 'time'] },
  });
  assert.equal(r.metadata.task_completion_rate, 80);
  assert.equal(r.score, 0.8);
});

test('task completion: null result key does not count as a result', () => {
  const r = taskCompletionScorer({ response: { result: null, other: 1 } });
  assert.equal(r.metadata.task_completion_rate, 80);
});

test('hallucination: forbidden text in a nested value flags 1 and scores 0', () => {
  const r = hallucinationScorer({
    response: { result: { text: 'I can book that' } },
    expectedOutcome: { forbidden_strings: ['BOOK THAT'] },
  });
  assert.equal(r.metadata.hallucination_flag, 1);
  assert.equal(r.score, 0);
});

test('hallucination: a forbidden key name alone does not flag (keys are excluded)', () => {
  const r = hallucinationScorer({
    response: { result: 'booked' },
    expectedOutcome: { forbidden_strings: ['result'] },
  });
  assert.equal(r.metadata.hallucination_flag, 0);
  assert.equal(r.score, 1);
});

test('hallucination: an empty forbidden string is skipped', () => {
  const r = hallucinationScorer({ response: { result: 'x' }, expectedOutcome: { forbidden_strings: [''] } });
  assert.equal(r.metadata.hallucination_flag, 0);
});

test('tool accuracy: recall of expected tools, extra calls not penalised', () => {
  const r = toolAccuracyScorer({
    response: { tool_calls: ['a', 'b', 'extra'] },
    expectedOutcome: { expected_tools: ['a', 'b'] },
  });
  assert.equal(r.score, 1);
});

test('tool accuracy: a missing expected tool gives partial credit', () => {
  const r = toolAccuracyScorer({
    response: { tool_calls: ['a'] },
    expectedOutcome: { expected_tools: ['a', 'b'] },
  });
  assert.equal(r.metadata.tool_accuracy, 50);
  assert.equal(r.score, 0.5);
});

test('tool accuracy: non-array tool_calls counts as no calls', () => {
  const r = toolAccuracyScorer({
    response: { tool_calls: 'a' },
    expectedOutcome: { expected_tools: ['a'] },
  });
  assert.equal(r.score, 0);
});

test('tool accuracy: no expected tools scores 1', () => {
  assert.equal(toolAccuracyScorer({ response: {} }).score, 1);
});

test('runLocalScorers composite matches the ai-runtime evaluator composite', async () => {
  const response = { result: 'ok', tool_calls: ['a'] };
  const expectedOutcome = { expected_keys: ['date'], expected_tools: ['a', 'b'], forbidden_strings: ['nope'] };
  const local = runLocalScorers({ response, expectedOutcome });
  const evaluated = await evaluateResponse({
    companyId: 'company-1',
    agentName: 'agent',
    sessionId: 'session',
    response,
    expectedOutcome,
  });
  assert.equal(local.composite * 100, evaluated.composite_score);
  assert.equal(local.results.length, 3);
});

test('runLocalScorers with a hallucination drops the composite by the 20 point weight', () => {
  const clean = runLocalScorers({ response: { result: 'ok' } });
  const dirty = runLocalScorers({
    response: { result: 'ok' },
    expectedOutcome: { forbidden_strings: ['ok'] },
  });
  assert.ok(Math.abs(clean.composite - dirty.composite - 0.2) < 1e-9);
});
