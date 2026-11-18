/**
 * Tests for the approval wait workflow step (W2, #391): server/integrations/voltagent/workflows/approval-step.ts.
 * Uses a scripted fake run engine. The step must never call a handler itself.
 * No network, no database, no @voltagent/core.
 * Run: node --test --experimental-strip-types tests/integrations/voltagent/approval-step.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalStep, WORKFLOWS_OFF_MESSAGE, workflowsEnabled } from '../../../server/integrations/voltagent/workflows/approval-step.ts';

const ON = { VOLTAGENT_WORKFLOWS_ENABLED: 'true' };
const OFF = {};
const CALL = { toolId: 'send_quote', params: { quoteId: 'q-1' } };
const INPUT = { companyId: 'co-1', runId: 'run-1', call: CALL };

function fakeEngine(script = {}) {
  const calls = [];
  return {
    calls,
    async callTool(...args) {
      calls.push(['callTool', ...args]);
      return script.callTool ?? { ok: false, reason: 'no_script' };
    },
    async resumeAfterApproval(...args) {
      calls.push(['resumeAfterApproval', ...args]);
      return script.resume ?? { ok: false, reason: 'no_script' };
    },
  };
}

test('workflows flag is on only when the value is exactly "true"', () => {
  assert.equal(workflowsEnabled(ON), true);
  assert.equal(workflowsEnabled({ VOLTAGENT_WORKFLOWS_ENABLED: 'TRUE' }), false);
  assert.equal(workflowsEnabled({ VOLTAGENT_WORKFLOWS_ENABLED: '1' }), false);
  assert.equal(workflowsEnabled(OFF), false);
});

test('building the step throws while the flag is off', () => {
  assert.throws(() => createApprovalStep({ engine: fakeEngine(), env: OFF }), new Error(WORKFLOWS_OFF_MESSAGE));
});

test('building the step needs an engine with both methods', () => {
  assert.throws(() => createApprovalStep({ engine: { callTool() {} }, env: ON }), TypeError);
});

test('start reports completed when the engine executed the tool', async () => {
  const engine = fakeEngine({ callTool: { ok: true, tool: { outcome: 'executed', toolId: 'send_quote', output: { sent: true } } } });
  const step = createApprovalStep({ engine, env: ON });
  const r = await step.start(INPUT);
  assert.deepEqual(r, { status: 'completed', runId: 'run-1', toolId: 'send_quote', output: { sent: true } });
  assert.deepEqual(engine.calls[0], ['callTool', 'co-1', 'run-1', CALL]);
});

test('start suspends with the approval id when the engine asks for approval', async () => {
  const engine = fakeEngine({ callTool: { ok: true, tool: { outcome: 'awaiting_approval', toolId: 'send_quote', approvalId: 'ap-9' } } });
  const r = await createApprovalStep({ engine, env: ON }).start(INPUT);
  assert.deepEqual(r, { status: 'suspended', runId: 'run-1', toolId: 'send_quote', approvalId: 'ap-9' });
});

test('start reports failed with the engine reason when the engine refuses the call', async () => {
  const engine = fakeEngine({ callTool: { ok: false, reason: 'tenant_mismatch' } });
  const r = await createApprovalStep({ engine, env: ON }).start(INPUT);
  assert.deepEqual(r, { status: 'failed', runId: 'run-1', reason: 'tenant_mismatch' });
});

test('start reports failed when the tool outcome is a refusal, using its reason', async () => {
  const engine = fakeEngine({ callTool: { ok: true, tool: { outcome: 'refused', toolId: 'send_quote', reason: 'params_invalid' } } });
  const r = await createApprovalStep({ engine, env: ON }).start(INPUT);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'params_invalid');
});

test('resume completes when the approved call executes', async () => {
  const engine = fakeEngine({
    resume: { ok: true, run: { status: 'completed' }, tool: { outcome: 'executed', toolId: 'send_quote', output: { sent: true } } },
  });
  const r = await createApprovalStep({ engine, env: ON }).resume(INPUT);
  assert.equal(r.status, 'completed');
  assert.deepEqual(engine.calls[0], ['resumeAfterApproval', 'co-1', 'run-1', CALL]);
});

test('resume fails and reports the reason when the approval was rejected (run failed, handler not run)', async () => {
  const engine = fakeEngine({
    resume: { ok: true, run: { status: 'failed' }, tool: { outcome: 'refused', toolId: 'send_quote', reason: 'approval_rejected' } },
  });
  const r = await createApprovalStep({ engine, env: ON }).resume(INPUT);
  assert.deepEqual(r, { status: 'failed', runId: 'run-1', reason: 'approval_rejected' });
});

test('a second resume after the wait is settled reports already_resolved and changes nothing', async () => {
  const engine = fakeEngine({ resume: { ok: false, reason: 'run_not_awaiting_approval', run: { status: 'completed' } } });
  const r = await createApprovalStep({ engine, env: ON }).resume(INPUT);
  assert.deepEqual(r, { status: 'already_resolved', runId: 'run-1', runStatus: 'completed' });
});

test('resume with no pending approval reports already_resolved with unknown status when the run is missing', async () => {
  const engine = fakeEngine({ resume: { ok: false, reason: 'no_pending_approval' } });
  const r = await createApprovalStep({ engine, env: ON }).resume(INPUT);
  assert.deepEqual(r, { status: 'already_resolved', runId: 'run-1', runStatus: 'unknown' });
});

test('an unexpected engine refusal on resume is reported as failed, not hidden', async () => {
  const engine = fakeEngine({ resume: { ok: false, reason: 'params_hash_mismatch' } });
  const r = await createApprovalStep({ engine, env: ON }).resume(INPUT);
  assert.deepEqual(r, { status: 'failed', runId: 'run-1', reason: 'params_hash_mismatch' });
});

test('turning the flag off after the step is built stops new start and resume calls', async () => {
  const env = { ...ON };
  const engine = fakeEngine({ callTool: { ok: true, tool: { outcome: 'executed', toolId: 't', output: {} } } });
  const step = createApprovalStep({ engine, env });
  delete env.VOLTAGENT_WORKFLOWS_ENABLED;
  await assert.rejects(() => step.start(INPUT), new Error(WORKFLOWS_OFF_MESSAGE));
  await assert.rejects(() => step.resume(INPUT), new Error(WORKFLOWS_OFF_MESSAGE));
  assert.equal(engine.calls.length, 0);
});
