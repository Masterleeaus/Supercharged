import test from "node:test";
import assert from "node:assert/strict";
import { createSqliteStorage } from "../../storage/src/index.js";
import { SqliteAuthorityStore } from "./sqlite-authority-store.mjs";

async function fixture(){
  const storage=createSqliteStorage(":memory:");
  for(const sql of [
    `CREATE TABLE authority_autonomy_snapshots(company_id TEXT NOT NULL,decision_id TEXT NOT NULL,capability TEXT NOT NULL,worker_id TEXT,status TEXT NOT NULL,verified_at TEXT NOT NULL,expires_at TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(company_id,decision_id))`,
    `CREATE TABLE authority_decisions(company_id TEXT NOT NULL,authority_decision_id TEXT NOT NULL,worker_id TEXT NOT NULL,capability TEXT NOT NULL,operation_id TEXT,action_id TEXT,decision TEXT NOT NULL,evaluated_at TEXT NOT NULL,supersedes_authority_decision_id TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(company_id,authority_decision_id))`,
    `CREATE TABLE authority_approvals(company_id TEXT NOT NULL,approval_id TEXT NOT NULL,approval_scope TEXT NOT NULL,status TEXT NOT NULL,approver_id TEXT,granted_at TEXT,expires_at TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(company_id,approval_id))`,
  ]) await storage.query(sql);
  return {storage,store:new SqliteAuthorityStore(storage)};
}

const snapshot=(company_id,decision_id,score=60)=>({company_id,decision_id,capability:"booking.create",effective_score:score,status:"verified",source:"titan-autonomy",verified_at:"2026-09-28T00:00:00Z",expires_at:"2026-09-29T00:00:00Z",trusted_auto_handshake:{platform:true,user:true,assurance:true},predictive_ready:false});

test("authority store resolves snapshots within company boundary",async()=>{
  const {storage,store}=await fixture();
  await store.appendAutonomySnapshot(snapshot("co-a","snap-a"),{worker_id:"worker-1"});
  await store.appendAutonomySnapshot(snapshot("co-b","snap-b"),{worker_id:"worker-1"});
  assert.equal((await store.latestAutonomySnapshot({company_id:"co-a",capability:"booking.create",worker_id:"worker-1"})).decision_id,"snap-a");
  await storage.close();
});

test("authority decisions require existing continuous supersession parent",async()=>{
  const {storage,store}=await fixture();
  const first={company_id:"co-a",authority_decision_id:"auth-1",worker_id:"worker-1",capability:"booking.create",operation_id:"op-1",action_id:"act-1",decision:"ALLOW",evaluated_at:"2026-09-28T00:00:00Z"};
  await store.appendDecision(first);
  await assert.rejects(()=>store.appendDecision({...first,authority_decision_id:"auth-2",supersedes_authority_decision_id:"missing",evaluated_at:"2026-09-28T00:01:00Z"}),/parent-missing/);
  const second={...first,authority_decision_id:"auth-2",supersedes_authority_decision_id:"auth-1",evaluated_at:"2026-09-28T00:01:00Z"};
  await store.appendDecision(second);
  assert.equal((await store.getDecision("co-a","auth-2")).supersedes_authority_decision_id,"auth-1");
  await storage.close();
});

test("scoped approvals do not cross companies",async()=>{
  const {storage,store}=await fixture();
  await store.appendApproval({company_id:"co-a",approval_id:"ap-a",approval_scope:"act-1",status:"approved",approver_id:"human-1",granted_at:"2026-09-28T00:00:00Z"});
  assert.equal((await store.latestApproval({company_id:"co-a",approval_scope:"act-1"})).approval_id,"ap-a");
  assert.equal(await store.latestApproval({company_id:"co-b",approval_scope:"act-1"}),null);
  await storage.close();
});


test("latest binding decision advances a single fork-free supersession chain",async()=>{
  const {storage,store}=await fixture();
  const base={company_id:"co-a",worker_id:"worker-1",capability:"booking.create",operation_id:"op-chain",action_id:"act-chain"};
  const first={...base,authority_decision_id:"auth-chain-1",decision:"ALLOW",evaluated_at:"2026-09-28T00:00:00Z"};
  const second={...base,authority_decision_id:"auth-chain-2",decision:"DENY",evaluated_at:"2026-09-28T00:01:00Z",supersedes_authority_decision_id:"auth-chain-1"};
  await store.appendDecision(first);
  await store.appendDecision(second);
  assert.equal((await store.latestDecisionForBinding(base)).authority_decision_id,"auth-chain-2");
  await assert.rejects(
    ()=>store.appendDecision({...base,authority_decision_id:"auth-chain-fork",decision:"ALLOW",evaluated_at:"2026-09-28T00:02:00Z",supersedes_authority_decision_id:"auth-chain-1"}),
    /authority-supersession-fork/,
  );
  const third={...base,authority_decision_id:"auth-chain-3",decision:"ALLOW",evaluated_at:"2026-09-28T00:03:00Z",supersedes_authority_decision_id:"auth-chain-2"};
  await store.appendDecision(third);
  assert.equal((await store.latestDecisionForBinding(base)).authority_decision_id,"auth-chain-3");
  await storage.close();
});
