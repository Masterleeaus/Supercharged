import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SqliteRunStore } from './sqlite-run-store.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function storage() {
  const db = new Database(':memory:');
  return {
    async query(sql, params=[]) { const bound=[]; const s=db.prepare(sql.replace(/\$(\d+)/g,(_,index)=>{bound.push(params[Number(index)-1]);return '?';})); if(s.reader){const rows=s.all(...bound);return {rows,rowCount:rows.length}} const r=s.run(...bound);return {rows:[],rowCount:r.changes}; },
    async close(){db.close();}
  };
}

test('SQLite RunStore persists and isolates runs by company', async () => {
  const db=storage(); const store=new SqliteRunStore(db);
  const run={company_id:'c1',run_id:'r1',state:'WAITING_EXTERNAL',conversation_id:'conv1',agent_id:'a1',work_id:'w1',updated_at:new Date().toISOString()};
  await store.create(run);
  assert.equal((await store.get('c1','r1')).state,'WAITING_EXTERNAL');
  assert.equal(await store.get('c2','r1'),null);
  assert.equal((await store.recoverable('c1')).length,1);
  run.state='COMPLETED'; run.updated_at=new Date().toISOString(); await store.save(run);
  assert.equal((await store.recoverable('c1')).length,0);
  await db.close();
});

for (const blockedStage of ['model', 'context', 'capability', 'authority', 'provider']) {
  test(`durable cancellation survives an active ${blockedStage} response without later execution or completion`, async () => {
    const { TitanAgentRuntime } = await import('./index.mjs');
    const db = storage();
    const store = new SqliteRunStore(db);
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const wait = async stage => { if (stage === blockedStage) { entered(); await blocked; } };
    let executions = 0;
    const events = [];
    const runtime = new TitanAgentRuntime({ store,
      contextProvider: { async load() { await wait('context'); return {}; } },
      modelRouter: { async next() { await wait('model'); return { tool_calls: [{ id: 'call-1', name: 'change', arguments: {} }] }; } },
      capabilities: { async resolve() { await wait('capability'); return { name: 'change' }; } },
      authorityGateway: {
        async authorize() { await wait('authority'); return { status: 'allowed' }; },
        async execute() { executions++; await wait('provider'); return { state: 'VERIFIED', evidence_ref: 'evidence-1', verified: true }; },
      },
    });
    runtime.events.subscribe(event => events.push(event));
    try {
      const pending = runtime.start({ company_id: 'c1', actor_id: 'one', agent_id: 'manager', conversation_id: 'conversation', work_id: 'work', run_id: 'run-active' });
      await reached;
      await runtime.cancel({ company_id: 'c1', run_id: 'run-active' });
      release();
      const result = await pending;
      assert.equal(result.state, 'CANCELLED');
      assert.equal((await store.get('c1', 'run-active')).state, 'CANCELLED');
      assert.equal(executions, blockedStage === 'provider' ? 1 : 0);
      assert.equal(events.some(event => ['run.completed', 'tool.completed'].includes(event.type)), false);
    } finally { release(); await db.close(); }
  });
}

test('stale cancellation cannot overwrite a completed SQLite run or its verified evidence', async () => {
  const { TitanAgentRuntime } = await import('./index.mjs');
  const db = storage();
  const store = new SqliteRunStore(db);
  let providerEntered;
  const providerReady = new Promise(resolve => { providerEntered = resolve; });
  let releaseProvider;
  const providerBlocked = new Promise(resolve => { releaseProvider = resolve; });
  let cancellationRead;
  const cancellationReady = new Promise(resolve => { cancellationRead = resolve; });
  let releaseCancellation;
  const cancellationBlocked = new Promise(resolve => { releaseCancellation = resolve; });
  const get = store.get.bind(store);
  let holdNextRead = false;
  store.get = async (...args) => {
    const snapshot = await get(...args);
    if (holdNextRead) {
      holdNextRead = false;
      assert.equal(snapshot.state, 'WAITING_TOOL');
      cancellationRead();
      await cancellationBlocked;
    }
    return snapshot;
  };
  let turns = 0;
  const events = [];
  const runtime = new TitanAgentRuntime({ store,
    modelRouter: { async next() { return turns++ === 0 ? { tool_calls: [{ id: 'verified-call', name: 'change', arguments: {} }] } : { final: 'Verified business result' }; } },
    capabilities: { async resolve() { return { name: 'change' }; } },
    authorityGateway: {
      async authorize() { return { status: 'allowed' }; },
      async execute() { providerEntered(); await providerBlocked; return { state: 'VERIFIED', verified: true, evidence_ref: 'accepted-evidence-1', output: 'changed' }; },
    },
  });
  runtime.events.subscribe(event => events.push(event));
  try {
    const executing = runtime.start({ company_id: 'c1', actor_id: 'one', agent_id: 'manager', conversation_id: 'conversation', work_id: 'work', run_id: 'race-run' });
    await providerReady;
    holdNextRead = true;
    const cancelling = runtime.cancel({ company_id: 'c1', run_id: 'race-run' });
    await cancellationReady;
    releaseProvider();
    const completed = await executing;
    assert.equal(completed.state, 'COMPLETED');
    releaseCancellation();
    const cancelled = await cancelling;
    assert.deepEqual(cancelled, completed);
    const persisted = await store.get('c1', 'race-run');
    assert.deepEqual(persisted, completed);
    assert.equal(persisted.result, 'Verified business result');
    assert.equal(persisted.messages.find(message => message.role === 'tool').evidence_ref, 'accepted-evidence-1');
    assert.equal(events.some(event => event.type === 'run.cancelled'), false);
  } finally { releaseProvider(); releaseCancellation(); await db.close(); }
});
