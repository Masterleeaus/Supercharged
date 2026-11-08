import assert from 'node:assert/strict';
import { createRestartCheckpointStore } from './restart-checkpoint.mjs';
import { createServiceWorkerLifecycle } from './service-worker-lifecycle.mjs';

function memoryDb(){
  const rows=new Map();return {
    async putRecord(ctx,input){const key=`${ctx.company_id}|${input.module_id}|${input.collection}|${input.record_id}`;const value={company_id:ctx.company_id,module_id:input.module_id,collection:input.collection,record_id:input.record_id,data:structuredClone(input.data),provenance:structuredClone(input.provenance)};rows.set(key,value);return structuredClone(value);},
    async getRecord(ctx,loc){return structuredClone(rows.get(`${ctx.company_id}|${loc.module_id}|${loc.collection}|${loc.record_id}`)||null);},
    async listRecords(ctx,q){return [...rows.values()].filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection).map(x=>structuredClone(x));},
  };
}
let now=1000;const db=memoryDb();const store=createRestartCheckpointStore({database:db,clock:()=>++now});
const lifecycle=createServiceWorkerLifecycle({checkpointStore:store,clock:()=>++now});
const ctx={company_id:'company-a',actor_id:'worker',operation_id:'lifecycle'};
await store.checkpoint(ctx,{operation_id:'op-1',type:'titan.work.started',idempotency_key:'idem-1'});
await store.checkpoint(ctx,{operation_id:'op-2',type:'titan.work.completed',idempotency_key:'idem-2'});
const suspended=await lifecycle.beforeSuspend(ctx,{reason:'chrome-runtime-onSuspend'});
assert.equal(suspended.status,'suspended');
assert.equal(suspended.company_id,'company-a');
assert.equal(suspended.operations.length,1);
assert.equal(suspended.operations[0].operation_id,'op-1');
assert.equal(suspended.operations[0].worker_lifecycle,'suspended');
assert.equal(suspended.operations[0].automatic_effect_replay,false);
assert.equal(suspended.operations[0].effect_replay_allowed,false);
const started=await lifecycle.afterStart(ctx);
assert.equal(started.status,'recovery-required');
assert.equal(started.recovered.length,1);
assert.equal(started.recovered[0].operation_id,'op-1');
assert.equal(started.recovered[0].state,'recovery_required');
assert.equal(started.recovered[0].worker_lifecycle,'recovery_required');
assert.equal(started.automatic_effect_replay,false);
assert.equal(started.requires_explicit_resume,true);
await assert.rejects(async()=>lifecycle.beforeSuspend({...ctx,company_id:'company-b'},{company_id:'company-a'}),/cross-company|company/i);
console.log('TZ-WP-003 Pass 5 service-worker suspend/resume lifecycle PASS');
