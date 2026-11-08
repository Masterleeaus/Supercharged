/**
 * The HTTP workforce runtime carries tasks only. Action and tool-execution requests are refused
 * with 'actions_not_allowed_over_http' before any request is sent. Uses a fake fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpWorkforceRuntime } from '../../server/integrations/workforce-runtime/http-runtime.ts';

const SECRET = 'TEST-WORKFORCE-SECRET-NOT-REAL-0123456789-ABCDEF';
const ORIGIN = 'https://runtime.example';
const TASK_ID = 'task_123';
const REFUSAL = 'actions_not_allowed_over_http';

const TASK = {
  idempotency_key: 'idem-0001',
  company_id: 'co_1',
  workflow: 'lead_followup',
  requested_by: 'user_7',
  resource: { kind: 'booking_request', reference: 'br_42' },
  payload: { note: 'follow up' },
};

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function runtimeWithCalls() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/v1/tasks') return json(200, { id: TASK_ID, status: 'pending', workflow: 'lead_followup', company_id: 'co_1' });
    if (path === `/v1/tasks/${TASK_ID}/cancel`) return json(200, { id: TASK_ID, status: 'cancelled', workflow: 'lead_followup', company_id: 'co_1' });
    if (path === `/v1/tasks/${TASK_ID}`) return json(200, { id: TASK_ID, status: 'running', workflow: 'lead_followup', company_id: 'co_1' });
    if (path === '/v1/health') return json(200, { ok: true });
    return json(404, {});
  };
  const runtime = new HttpWorkforceRuntime({ baseUrl: ORIGIN, secret: SECRET, timeoutMs: 1000, fetchImpl });
  return { runtime, calls };
}

async function assertRefused(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, REFUSAL);
    assert.equal(error.name, 'WorkforceRuntimeError');
    return true;
  });
}

const ACTION_INPUTS = {
  'action workflow': { ...TASK, workflow: 'action.send_email' },
  'tool workflow': { ...TASK, workflow: 'tools.run' },
  'action resource kind': { ...TASK, resource: { kind: 'tool_call', reference: 'x_1' } },
  'top-level tool key': { ...TASK, tool: 'send_sms' },
  'top-level actions key': { ...TASK, actions: [{ type: 'send' }] },
  'tool_name in payload': { ...TASK, payload: { tool_name: 'crm.update' } },
  'nested action key': { ...TASK, payload: { step: { action: 'delete' } } },
  'execute key in payload': { ...TASK, payload: { execute: true } },
};

for (const [label, input] of Object.entries(ACTION_INPUTS)) {
  test(`submitTask refuses an action request (${label}) without sending anything`, async () => {
    const { runtime, calls } = runtimeWithCalls();
    await assertRefused(runtime.submitTask(input));
    assert.equal(calls.length, 0, 'no request may be sent for an action');
  });
}

test('input nested too deeply to scan is refused as invalid, not sent', async () => {
  const { runtime, calls } = runtimeWithCalls();
  let deep = { note: 'x' };
  for (let i = 0; i < 20; i += 1) deep = { next: deep };
  await assert.rejects(runtime.submitTask({ ...TASK, payload: deep }), (error) => {
    assert.equal(error.code, 'runtime_invalid_input');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('an action path is refused before any request is built', async () => {
  const { runtime, calls } = runtimeWithCalls();
  await assert.rejects(runtime.request('POST', '/v1/actions/run', '{}'), (error) => {
    assert.equal(error.code, REFUSAL);
    return true;
  });
  await assert.rejects(runtime.request('POST', '/v1/tools/execute', '{}'), (error) => {
    assert.equal(error.code, REFUSAL);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a task id named like an action is not refused as an action', async () => {
  const { runtime, calls } = runtimeWithCalls();
  await assert.rejects(runtime.getTask('tools'), (error) => error.code !== REFUSAL);
  assert.equal(calls.length, 1, 'the task request is still sent');
});

test('task requests keep working: submit, get, cancel and health', async () => {
  const { runtime, calls } = runtimeWithCalls();
  const submitted = await runtime.submitTask(TASK);
  assert.equal(submitted.id, TASK_ID);
  assert.equal(submitted.status, 'pending');

  const fetched = await runtime.getTask(TASK_ID);
  assert.equal(fetched.status, 'running');

  const cancelled = await runtime.cancelTask(TASK_ID);
  assert.equal(cancelled.status, 'cancelled');

  assert.deepEqual(await runtime.health(), { ok: true });
  assert.equal(calls.length, 4);
});

test('a normal task whose payload mentions no action keys is accepted', async () => {
  const { runtime, calls } = runtimeWithCalls();
  const task = await runtime.submitTask({ ...TASK, payload: { note: 'call back', count: 2, tags: ['vip'] } });
  assert.equal(task.id, TASK_ID);
  assert.equal(calls.length, 1);
});
