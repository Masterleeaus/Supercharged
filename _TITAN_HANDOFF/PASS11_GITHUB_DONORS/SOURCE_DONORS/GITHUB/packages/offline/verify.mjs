import assert from 'node:assert/strict';
import {createRestartCheckpointStore,isTerminalRuntimeType} from './restart-checkpoint.mjs';
function memoryDb(){
 const rows=new Map();return {
  async putRecord(ctx,input){const key=`${ctx.company_id}|${input.module_id}|${input.collection}|${input.record_id}`;const prior=rows.get(key);const value={pk:key,company_id:ctx.company_id,module_id:input.module_id,collection:input.collection,record_id:input.record_id,data:structuredClone(input.data),provenance:structuredClone(input.provenance),created_at:prior?.created_at||1,updated_at:2};rows.set(key,value);return structuredClone(value)},
  async getRecord(ctx,loc){return structuredClone(rows.get(`${ctx.company_id}|${loc.module_id}|${loc.collection}|${loc.record_id}`)||null)},
  async listRecords(ctx,q){return [...rows.values()].filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection).map(x=>structuredClone(x))},
 };
}
let now=100;const db=memoryDb();const store=createRestartCheckpointStore({database:db,clock:()=>++now});
const ctx={company_id:'company-a',actor_id:'worker-a',operation_id:'op-1'};
await store.checkpoint(ctx,{type:'titan.work.started',operation_id:'op-1',correlation_id:'corr-1',idempotency_key:'idem-1'});
assert.equal((await store.pending(ctx)).length,1);
const restartedStore=createRestartCheckpointStore({database:db,clock:()=>++now});
const recovered=await restartedStore.recover(ctx);assert.equal(recovered.length,1);assert.equal(recovered[0].requires_explicit_resume,true);assert.equal(recovered[0].automatic_effect_replay,false);
await assert.rejects(()=>restartedStore.acknowledgeResume(ctx,{operation_id:'op-1',idempotency_key:'wrong'}),/idempotency/);
const resumed=await restartedStore.acknowledgeResume(ctx,{operation_id:'op-1',idempotency_key:'idem-1'});assert.equal(resumed.state,'resumed');
await store.checkpoint(ctx,{type:'titan.work.complete',operation_id:'op-1'});assert.equal((await store.pending(ctx)).length,0);
await assert.rejects(()=>store.checkpoint({company_id:'company-b',operation_id:'op-2',tenant_id:'legacy'},{type:'x'}),/legacy-company-boundary/);
assert.equal(isTerminalRuntimeType('titan.work.result'),true);assert.equal(isTerminalRuntimeType('titan.work.progress'),false);
console.log('P2-010 restart checkpoint verification PASS');
