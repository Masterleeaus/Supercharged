import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStorage } from '../storage/src/index.ts';
import { ExecutionGateway, boundedAdapterCall } from './execution-gateway.mjs';
import { GovernedExecutionRecovery, SqliteExecutionLifecycleStore } from './governed-execution-recovery.mjs';

const request = { company_id:'company-1',execution_id:'execution-1',capability:'job.complete',input:{job_id:'job-1'},idempotency_key:'complete-job-1',actor_id:'actor-1',work_id:'work-1',run_id:'run-1',authority:{status:'approved'} };
const provider = (execute,verify) => ({id:'native',executionClass:'native',capabilities:['job.complete'],execute,verify});

async function diskFixture() {
  const directory=await mkdtemp(join(tmpdir(),'execution-lifecycle-'));
  const filename=join(directory,'runtime.sqlite');
  let storage=createSqliteStorage(filename);
  let store=new SqliteExecutionLifecycleStore(storage);await store.migrate();
  return {store:()=>store,storage:()=>storage,
    async restart(){await storage.close();storage=createSqliteStorage(filename);store=new SqliteExecutionLifecycleStore(storage);await store.migrate();return store;},
    async close(){await storage.close();await rm(directory,{recursive:true,force:true});}};
}

test('bounded adapter rejects invalid bounds, skips pre-aborted calls, and ignores late resolution',async()=>{
  for(const timeoutMs of [0,-1,NaN,Infinity,2**32])assert.throws(()=>boundedAdapterCall(async()=>{}, {timeoutMs}),{code:'INVALID_ADAPTER_TIMEOUT'});
  let calls=0;const controller=new AbortController();controller.abort();
  await assert.rejects(()=>boundedAdapterCall(async()=>{calls++;},{signal:controller.signal}),{code:'ADAPTER_ABORTED'});assert.equal(calls,0);
  let signal;let release;
  const pending=boundedAdapterCall(child=>{signal=child;return new Promise(resolve=>{release=resolve;});},{timeoutMs:5});
  await assert.rejects(()=>pending,{code:'ADAPTER_TIMEOUT'});assert.equal(signal.aborted,true);
  release('late-success');await Promise.resolve();
  await assert.rejects(()=>pending,{code:'ADAPTER_TIMEOUT'});
});

test('timed-out dispatch stays UNCERTAIN and only current-authority reconciliation may verify',async()=>{
  let executions=0,verifications=0,signal,release;
  const evidence=[];
  const gateway=new ExecutionGateway({timeoutMs:5,evidenceSink:async event=>evidence.push(event),providers:[provider(child=>{executions++;signal=child.signal;return new Promise(resolve=>{release=resolve;});},async(_raw,current)=>{verifications++;assert.equal(current.reconciliation_only,true);return {verified:true,method:'observed-native-row'};})]});
  const timed=await gateway.execute(request);
  assert.equal(timed.state,'UNCERTAIN');assert.equal(timed.evidence.failure.code,'ADAPTER_TIMEOUT');assert.equal(signal.aborted,true);
  release({result:'late'});await Promise.resolve();assert.equal(verifications,0);assert.equal(evidence.some(event=>event.state==='VERIFIED'),false);
  assert.equal((await gateway.execute(request)).state,'UNCERTAIN');assert.equal(executions,1);
  for(const authority of [{status:'denied'},{status:'approved',revoked:true},{status:'approved',expires_at:'bad-date'},{status:'approved',expires_at:'2000-01-01'}])assert.equal((await gateway.reconcile({...request,authority})).state,'DENIED');
  assert.equal(verifications,0);
  assert.equal((await gateway.reconcile(request)).state,'VERIFIED');assert.equal(executions,1);assert.equal(verifications,1);
  await assert.rejects(()=>gateway.execute({...request,input:{job_id:'job-2'}}),{code:'EXECUTION_IDENTITY_MISMATCH'});
});

test('verification timeout and caller abort never emit verified evidence',async()=>{
  for(const mode of ['timeout','abort']){
    let entered;const started=new Promise(resolve=>{entered=resolve;});const controller=new AbortController();let verifySignal;
    const evidence=[];const gateway=new ExecutionGateway({timeoutMs:mode==='timeout'?5:1000,evidenceSink:async event=>evidence.push(event),providers:[provider(async()=>({external_ref:'ack'}),async(_raw,current)=>{verifySignal=current.signal;entered();return new Promise(()=>{});})]});
    const pending=gateway.execute({...request,signal:controller.signal});await started;if(mode==='abort')controller.abort();const result=await pending;
    assert.equal(result.state,'UNCERTAIN');assert.equal(result.evidence.failure.code,mode==='abort'?'ADAPTER_ABORTED':'ADAPTER_TIMEOUT');assert.equal(verifySignal.aborted,true);assert.equal(evidence.some(event=>event.state==='VERIFIED'),false);
  }
});

test('disk lifecycle preserves request correlation and reconciles unknown dispatch after restart without replay',async()=>{
  const f=await diskFixture();let executes=0,verifies=0;
  try {
    const gateway=new ExecutionGateway({providers:[provider(async()=>{executes++;throw new Error('socket lost after mutation');},async()=>{verifies++;return true;})]});
    let recovery=new GovernedExecutionRecovery({gateway,store:f.store()});await recovery.start(request);
    assert.equal((await recovery.resume(request.execution_id,request)).state,'UNCERTAIN');
    const restarted=await f.restart();
    const nextGateway=new ExecutionGateway({providers:[provider(async()=>{executes++;throw new Error('must-not-execute');},async()=>{verifies++;return true;})]});
    recovery=new GovernedExecutionRecovery({gateway:nextGateway,store:restarted});
    assert.equal((await recovery.retry(request.execution_id,request)).state,'VERIFIED');assert.equal(executes,1);assert.equal(verifies,1);
    const record=await recovery.get(request.execution_id,request.company_id);assert.equal(record.request.actor_id,'actor-1');assert.equal(record.request.run_id,'run-1');assert.equal(record.request.authority,undefined);
    assert.equal((await recovery.resume(request.execution_id,request)).duplicate,true);
    await assert.rejects(()=>recovery.start({...request,input:{job_id:'other'}}),/identity-mismatch/);
    await assert.rejects(()=>recovery.resume(request.execution_id,{...request,idempotency_key:'different'}),/identity-mismatch/);
    await assert.rejects(()=>recovery.resume(request.execution_id,{...request,company_id:'company-2'}),/company-context/);
    assert.equal((await recovery.history(request.execution_id,request.company_id)).length,5);
  } finally {await f.close();}
});

test('orphan RUNNING lifecycle is verification-only and concurrent durable claim has one winner',async()=>{
  const f=await diskFixture();
  try {
    let execute=0,verify=0;
    let recovery=new GovernedExecutionRecovery({store:f.store(),gateway:{async execute(){execute++;return {state:'VERIFIED'};},async reconcile(){verify++;return {state:'UNCERTAIN'};}}});
    const ready=await recovery.start(request);const running={...ready,status:'RUNNING',attempt:1};
    const claims=await Promise.all([f.store().claim(ready,running,{...running,type:'RESUMED'}),f.store().claim(ready,{...running,attempt:2},{...running,type:'RESUMED'})]);assert.deepEqual(claims,[true,false]);
    recovery=new GovernedExecutionRecovery({store:await f.restart(),gateway:{async execute(){execute++;return {state:'VERIFIED'};},async reconcile(){verify++;return {state:'UNCERTAIN'};}}});
    assert.equal((await recovery.resume(request.execution_id,request)).state,'UNCERTAIN');assert.equal(execute,0);assert.equal(verify,1);
    const history=await recovery.history(request.execution_id,request.company_id);assert.equal(history.filter(event=>event.status==='RUNNING').length,1);
  } finally {await f.close();}
});

test('simultaneous lifecycle starts and resumes execute at most once',async()=>{
  const f=await diskFixture();let executions=0;
  try {
    const gateway={async execute(){executions++;return {state:'VERIFIED'};},async reconcile(){return {state:'UNCERTAIN'};}};
    const left=new GovernedExecutionRecovery({gateway,store:f.store()});const right=new GovernedExecutionRecovery({gateway,store:new SqliteExecutionLifecycleStore(f.storage())});
    await Promise.all([left.start(request),right.start(request)]);
    const results=await Promise.allSettled([left.resume(request.execution_id,request),right.resume(request.execution_id,request)]);
    assert.equal(executions,1);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal((await f.store().history(request.company_id,request.execution_id)).filter(event=>event.type==='STARTED').length,1);
  } finally {await f.close();}
});

 test('falsy adapter rejection reasons remain rejections and abort the child transport',async()=>{
  for(const reason of [undefined,null,0,'',false]) {
    let signal;let rejected=false;
    try { await boundedAdapterCall(child=>{signal=child;return Promise.reject(reason);},{timeoutMs:50}); }
    catch(error){rejected=true;assert.equal(error,reason);}
    assert.equal(rejected,true);assert.equal(signal.aborted,true);
  }
});

 test('terminal duplicate requires current authority and retains prior verified history on denial',async()=>{
  const f=await diskFixture();
  try {
    let executes=0;
    const gateway=new ExecutionGateway({providers:[provider(async()=>{executes++;return {};},async()=>true)]});
    const recovery=new GovernedExecutionRecovery({gateway,store:f.store()});await recovery.start(request);
    await recovery.resume(request.execution_id,request);
    const before=await recovery.get(request.execution_id,request.company_id);
    for(const authority of [{status:'denied'},{status:'approved',revoked:true},{status:'approved',expires_at:'2000-01-01'},{status:'approved',expires_at:'invalid'}]) {
      assert.equal((await recovery.resume(request.execution_id,{...request,authority})).state,'DENIED');
      assert.deepEqual(await recovery.get(request.execution_id,request.company_id),before);
    }
    assert.equal(executes,1);
  } finally {await f.close();}
});

test('recovery overtaking an active owner cannot turn its completion conflict into a provider retry',async()=>{
  const f=await diskFixture();let executions=0,verifications=0;
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  try {
    const gateway={async execute(){executions++;entered();await blocked;return {state:'VERIFIED'};},async reconcile(){verifications++;return {state:'UNCERTAIN'};}};
    const owner=new GovernedExecutionRecovery({gateway,store:f.store()});const recovering=new GovernedExecutionRecovery({gateway,store:f.store()});
    await owner.start(request);const pending=owner.resume(request.execution_id,request);await started;
    assert.equal((await recovering.resume(request.execution_id,request)).state,'UNCERTAIN');
    release();await assert.rejects(()=>pending,/execution-lifecycle-claim-conflict/);
    assert.equal((await recovering.retry(request.execution_id,request)).state,'UNCERTAIN');
    assert.equal(executions,1);assert.equal(verifications,2);assert.equal((await recovering.get(request.execution_id,request.company_id)).status,'UNCERTAIN');
  } finally {release();await f.close();}
});
