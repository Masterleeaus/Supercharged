import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStorage } from '../../../packages/storage/src/index.js';
import { createProductionRuntimeBootstrap } from './production-runtime-bootstrap.js';

const authenticated_identity = { provider: 'directadmin', subject: 'subject-1', session_id: 'session-1', device_id: 'device-1', session_revision: 1, audience: 'workforce', company_id: 'company-1', actor_id: 'actor-1', context_revision: 'context-1', surface: 'zero' };
const input = { company_id: 'company-1', actor_id: 'actor-1', conversation_id: 'conversation-1', interaction_id: 'interaction-1', client_message_id: 'message-1', text: 'Inspect schedule', correlation_id: 'correlation-1', request_id: 'request-1', operation_id: 'operation-1', trace_id: 'trace-1', idempotency_key: 'idempotency-1', session_id: 'session-1', context_revision: 'context-1', authenticated_identity };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zero-correlation-'));
  const filename = join(directory, 'runtime.sqlite');
  let storage = createSqliteStorage(filename);
  let calls = 0;
  const ports = {
    modelRouter: { async next() { calls++; return { wait: { state: 'WAITING_USER' } }; } },
    capabilities: { async resolve() { return null; } },
    authorityGateway: { async authorize() { return { status: 'denied' }; }, async execute() { throw new Error('unexpected-execution'); } },
    contextProvider: { async load() { return {}; } },
  };
  const bootstrap = await createProductionRuntimeBootstrap({ storage, ports });
  await bootstrap.workforce.registerWorker({ company_id: input.company_id, worker_id: 'manager-1', active: true, kind: 'digital', capabilities: ['work.delegate'] });
  return { bootstrap, calls: () => calls, storage: () => storage,
    async restart() { await storage.close(); storage = createSqliteStorage(filename); return createProductionRuntimeBootstrap({ storage, ports }); },
    async close() { await storage.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('correlation and authenticated session binding survive real SQLite close/reopen', async () => {
  const f = await fixture();
  try {
    const first = await f.bootstrap.dispatch(input);
    const event = first.events.find(event => event.kind === 'run.started')!;
    for (const key of ['request_id', 'operation_id', 'trace_id', 'idempotency_key', 'actor_id'] as const) assert.equal(event[key], input[key]);
    const restarted = await f.restart();
    const work = await restarted.workforceStore.get(input.company_id, 'zero:conversation-1:message-1');
    const rows = await f.storage().query<{ payload: string }>('SELECT payload FROM agent_runs WHERE company_id=$1', [input.company_id]);
    const run = JSON.parse(rows.rows[0]!.payload);
    for (const key of ['request_id', 'operation_id', 'trace_id', 'idempotency_key', 'session_id', 'context_revision', 'authenticated_identity'] as const) {
      assert.deepEqual(work?.origin?.[key], input[key]);
      assert.deepEqual(run[key], input[key]);
    }
    await restarted.dispatch(input);
    assert.equal(f.calls(), 1);
    for (const changed of [{ text: 'Delete schedule' }, { trace_id: 'altered' }, { operation_id: 'altered' }, { request_id: 'altered' }, { idempotency_key: 'altered' }, { interaction_id: 'altered' }]) {
      await assert.rejects(() => restarted.dispatch({ ...input, ...changed }), /zero-work-replay-conflict/);
    }
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('continuation and cancellation reject stale session/company/actor identity before runtime execution', async () => {
  const f = await fixture();
  try {
    const first = await f.bootstrap.dispatch(input);
    const restarted = await f.restart();
    for (const changed of [{ session_id: 'session-2' }, { context_revision: 'context-2' }, { authenticated_identity: { ...authenticated_identity, session_revision: 2 } }, { authenticated_identity: undefined }, { actor_id: 'actor-2' }, { company_id: 'company-2' }]) {
      await assert.rejects(() => restarted.dispatch({ ...input, ...changed, continuation_token: first.continuation_token }), /zero-(work-.*conflict|continuation-work-not-found)/);
      await assert.rejects(() => restarted.zeroDispatcher.cancel({ ...input, ...changed, continuation_token: first.continuation_token! }), /zero-(work-.*conflict|continuation-work-not-found)/);
    }
    assert.equal(f.calls(), 1);
    // An authenticated continuation can wake a waiting run without inventing user text.
    await restarted.dispatch({ ...input, text: undefined, client_message_id: 'message-2', continuation_token: first.continuation_token });
    assert.equal(f.calls(), 2);
    const rows = await f.storage().query<{ payload: string }>('SELECT payload FROM agent_runs WHERE company_id=$1', [input.company_id]);
    assert.equal(JSON.parse(rows.rows[0]!.payload).messages.length, 1);
    const cancelled = await restarted.zeroDispatcher.cancel({ ...input, continuation_token: first.continuation_token! });
    assert.equal(cancelled.events.at(-1)?.state, 'CANCELLED');
  } finally { await f.close(); }
});

test('continuation receipts atomically deduplicate client messages across restart and reject altered payload', async () => {
  const f = await fixture();
  try {
    const first = await f.bootstrap.dispatch(input);
    const continuation = { ...input, client_message_id: 'continuation-1', text: 'Continue inspecting', continuation_token: first.continuation_token };
    await f.bootstrap.dispatch(continuation);
    assert.equal(f.calls(), 2);
    const restarted = await f.restart();
    await restarted.dispatch(continuation);
    assert.equal(f.calls(), 2);
    await assert.rejects(() => restarted.dispatch({ ...continuation, text: 'Different instruction' }), /runtime-continuation-replay-conflict/);
    await assert.rejects(() => restarted.dispatch({ ...continuation, operation_id: 'different-operation' }), /runtime-continuation-replay-conflict/);
    assert.equal(f.calls(), 2);
    const rows = await f.storage().query<{ payload: string }>('SELECT payload FROM agent_runs WHERE company_id=$1', [input.company_id]);
    const run = JSON.parse(rows.rows[0]!.payload);
    assert.equal(run.continuation_receipts.length, 1);
    assert.equal(run.messages.length, 2);
    assert.equal(run.continuation_receipts[0].operation_id, input.operation_id);
  } finally { await f.close(); }
});
