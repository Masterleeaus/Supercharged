import assert from 'node:assert/strict';
import { createReplaySafeRecoveryStateMachine } from './recovery-state-machine.mjs';

const sm=createReplaySafeRecoveryStateMachine();
const active={schema:'titan.offline.restart-checkpoint.v1',company_id:'company-a',operation_id:'op-1',state:'active',terminal:false,idempotency_key:'idem-1'};
const recovery=sm.transition(active,'recover',{at:10});
assert.equal(recovery.state,'recovery_required');
assert.equal(recovery.requires_explicit_resume,true);
assert.equal(recovery.automatic_effect_replay,false);
assert.equal(recovery.effect_replay_allowed,false);
assert.equal(recovery.authority_neutral,true);
assert.equal(recovery.recovery_count,1);

await assert.rejects(async()=>sm.transition(recovery,'resume',{idempotency_key:'wrong',at:11}),/idempotency/i);
const resumed=sm.transition(recovery,'resume',{idempotency_key:'idem-1',at:12});
assert.equal(resumed.state,'resumed');
assert.equal(resumed.requires_explicit_resume,false);
assert.equal(resumed.effect_replay_allowed,false);

const completed=sm.transition(resumed,'complete',{at:13});
assert.equal(completed.state,'completed');
assert.equal(completed.terminal,true);
assert.equal(completed.effect_replay_allowed,false);
await assert.rejects(async()=>sm.transition(completed,'recover',{at:14}),/terminal/i);
await assert.rejects(async()=>sm.transition(active,'resume',{idempotency_key:'idem-1',at:15}),/illegal-transition/i);
await assert.rejects(async()=>sm.transition({...active,company_id:'company-b'},'recover',{company_id:'company-a',at:16}),/cross-company/i);
await assert.rejects(async()=>sm.transition({...active,tenant_id:'legacy'},'recover',{at:17}),/legacy-company-boundary/i);
console.log('TZ-WP-003 Pass 3 replay-safe recovery state machine PASS');

import { createRestartCheckpointStore } from './restart-checkpoint.mjs';
function memoryDb(){
  const rows=new Map();return {
    async putRecord(ctx,input){const key=`${ctx.company_id}|${input.module_id}|${input.collection}|${input.record_id}`;const value={company_id:ctx.company_id,module_id:input.module_id,collection:input.collection,record_id:input.record_id,data:structuredClone(input.data),provenance:structuredClone(input.provenance)};rows.set(key,value);return structuredClone(value);},
    async getRecord(ctx,loc){return structuredClone(rows.get(`${ctx.company_id}|${loc.module_id}|${loc.collection}|${loc.record_id}`)||null);},
    async listRecords(ctx,q){return [...rows.values()].filter(r=>r.company_id===ctx.company_id&&r.module_id===q.module_id&&r.collection===q.collection).map(x=>structuredClone(x));},
  };
}
let now=20;const db=memoryDb();const store=createRestartCheckpointStore({database:db,clock:()=>++now});const ctx={company_id:'company-a',operation_id:'op-2'};
await store.checkpoint(ctx,{type:'titan.work.started',operation_id:'op-2',idempotency_key:'idem-2'});
const recoveredRows=await store.recover(ctx);assert.equal(recoveredRows[0].effect_replay_allowed,false);
const resumedRow=await store.acknowledgeResume(ctx,{operation_id:'op-2',idempotency_key:'idem-2'});assert.equal(resumedRow.effect_replay_allowed,false);
