import assert from 'node:assert/strict';
import { createOfflineConflictRetryPolicy } from './conflict-retry-policy.mjs';

const policy=createOfflineConflictRetryPolicy({clock:()=>5000});
const base={company_id:'co-a',operation_id:'op-1',idempotency_key:'idem-1',state:'recovery_required',terminal:false,retry_count:0};

const transient=policy.evaluate(base,{company_id:'co-a',failure_class:'network_unavailable'});
assert.equal(transient.disposition,'retry_scheduled');
assert.equal(transient.retry_allowed,true);
assert.equal(transient.requires_explicit_resume,true);
assert.equal(transient.automatic_effect_replay,false);
assert.equal(transient.effect_replay_allowed,false);
assert.equal(transient.authority_neutral,true);
assert.equal(transient.retry_count,1);
assert.ok(transient.next_retry_at>5000);

const ambiguous=policy.evaluate(base,{company_id:'co-a',failure_class:'unknown_effect_outcome'});
assert.equal(ambiguous.disposition,'manual_review_required');
assert.equal(ambiguous.retry_allowed,false);
assert.equal(ambiguous.requires_explicit_resume,true);

const conflict=policy.evaluate(base,{company_id:'co-a',failure_class:'stale_state_conflict'});
assert.equal(conflict.disposition,'conflict_review_required');
assert.equal(conflict.retry_allowed,false);

const denied=policy.evaluate(base,{company_id:'co-a',failure_class:'authority_denied'});
assert.equal(denied.disposition,'blocked');
assert.equal(denied.retry_allowed,false);

assert.throws(()=>policy.evaluate(base,{company_id:'co-b',failure_class:'network_unavailable'}),/cross-company/);
assert.throws(()=>policy.evaluate({...base,tenant_id:'legacy'},{company_id:'co-a',failure_class:'network_unavailable'}),/legacy-company-boundary/);

const exhausted=policy.evaluate({...base,retry_count:5},{company_id:'co-a',failure_class:'network_unavailable',max_retries:5});
assert.equal(exhausted.disposition,'retry_exhausted');
assert.equal(exhausted.retry_allowed,false);

console.log('verify-pass06 PASS');

import { createRestartCheckpointStore } from './restart-checkpoint.mjs';
function memoryDb(){
  const rows=new Map();return {
    async putRecord(ctx,input){const key=`${ctx.company_id}|${input.module_id}|${input.collection}|${input.record_id}`;const value={company_id:ctx.company_id,module_id:input.module_id,collection:input.collection,record_id:input.record_id,data:structuredClone(input.data),provenance:structuredClone(input.provenance)};rows.set(key,value);return structuredClone(value);},
    async getRecord(ctx,loc){return structuredClone(rows.get(`${ctx.company_id}|${loc.module_id}|${loc.collection}|${loc.record_id}`)||null);},
    async listRecords(ctx,q){return [...rows.values()].filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection).map(x=>structuredClone(x));},
  };
}
const db=memoryDb();const store=createRestartCheckpointStore({database:db,clock:()=>6000});const ctx={company_id:'co-a',actor_id:'worker',operation_id:'retry'};
await store.checkpoint(ctx,{operation_id:'op-r',type:'titan.work.started',idempotency_key:'idem-r'});
const decision=await store.evaluateConflictRetry(ctx,{operation_id:'op-r',failure_class:'network_unavailable'});
assert.equal(decision.disposition,'retry_scheduled');
assert.equal(decision.retry_allowed,true);
assert.equal(decision.effect_replay_allowed,false);
const pending=(await store.pending(ctx)).find(x=>x.operation_id==='op-r');
assert.equal(pending.disposition,'retry_scheduled');
assert.equal(pending.retry_count,1);
console.log('verify-pass06 integration PASS');
