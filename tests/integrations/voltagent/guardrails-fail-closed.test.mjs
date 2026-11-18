/**
 * W10 (#391): fail-closed contract tests for the VoltAgent guardrail adapter on main.
 * Verdict rules stay in server/services/ai-runtime/guardrail.ts. These tests pin the adapter's shape rules.
 * No network, no database.
 * Run: node --test --experimental-strip-types tests/integrations/voltagent/guardrails-fail-closed.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toVoltGuardrail } from '../../../server/integrations/voltagent/guardrails/adapter.ts';

const input = { companyId: 'co-1', text: 'hello' };

test('W10 a guardrail that throws rejects; it never returns a pass', async () => {
  const guard = toVoltGuardrail({
    evaluate: () => {
      throw new Error('screen offline');
    },
  });
  await assert.rejects(guard(input), /screen offline/);
});

test('W10 null, undefined and string verdicts block with the default reason', async () => {
  for (const verdict of [null, undefined, 'pass', true]) {
    const guard = toVoltGuardrail({ evaluate: () => verdict });
    assert.deepEqual(await guard(input), { pass: false, reason: 'blocked by guardrail' }, `verdict ${String(verdict)}`);
  }
});

test('W10 a string pass value blocks (only boolean true passes)', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: 'true' }) });
  assert.equal((await guard(input)).pass, false);
});

test('W10 a pass verdict drops any reason and returns exactly { pass: true }', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: true, reason: 'ignored' }) });
  assert.deepEqual(await guard(input), { pass: true });
});

test('W10 a block verdict without a string reason gets the default reason', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: false, reason: 42 }) });
  assert.deepEqual(await guard(input), { pass: false, reason: 'blocked by guardrail' });
});

test('W10 a block verdict keeps its string reason', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: false, reason: 'blocked term' }) });
  assert.deepEqual(await guard(input), { pass: false, reason: 'blocked term' });
});

test('W10 the stage defaults to input and passes through when given', async () => {
  const seen = [];
  const guard = toVoltGuardrail({
    evaluate: (req) => {
      seen.push(req.context.stage);
      return { pass: true };
    },
  });
  await guard(input);
  await guard({ ...input, context: 'output' });
  assert.deepEqual(seen, ['input', 'output']);
});

test('W10 a non-string text is screened as empty text, not as an object', async () => {
  const seen = [];
  const guard = toVoltGuardrail({
    evaluate: (req) => {
      seen.push(req.text);
      return { pass: true };
    },
  });
  await guard({ companyId: 'co-1', text: { nested: 'x' } });
  assert.deepEqual(seen, ['']);
});
