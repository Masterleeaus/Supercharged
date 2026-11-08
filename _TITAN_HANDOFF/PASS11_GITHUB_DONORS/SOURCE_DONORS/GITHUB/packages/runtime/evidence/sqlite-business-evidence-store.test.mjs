import test from "node:test";
import assert from "node:assert/strict";
import { createSqliteStorage } from "../../storage/src/index.js";
import { SqliteBusinessEvidenceStore } from "./sqlite-business-evidence-store.mjs";

async function fixture(){
 const storage=createSqliteStorage(":memory:");
 await storage.query(`CREATE TABLE evidence(
 id TEXT PRIMARY KEY,company_id TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,evidence_type TEXT NOT NULL,
 provenance TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,evidence_version INTEGER NOT NULL,classification TEXT NOT NULL,
 acceptance_state TEXT NOT NULL,event_type TEXT,source_type TEXT,source_id TEXT,actor_id TEXT,agent_id TEXT,correlation_id TEXT,causation_id TEXT,
 decision_id TEXT,authority_decision_id TEXT,execution_id TEXT,verification_id TEXT,projection_version TEXT,supersedes_evidence_id TEXT,occurred_at TEXT,accepted_at TEXT)`);
 await storage.query(`CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'business-evidence-immutable'); END`);
 await storage.query(`CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'business-evidence-immutable'); END`);
 return {storage,store:new SqliteBusinessEvidenceStore(storage)};
}
const evidence=(id,company_id="co-a")=>({evidence_id:id,evidence_version:1,company_id,subject_type:"job",subject_id:"job-1",classification:"factual",acceptance_state:"accepted",event_type:"job.status.verified",source_type:"execution-gateway",source_id:"gateway-1",correlation_id:"corr-1",verification_id:"verify-1",projection_version:"job-reality.v1",provenance:{source:"test"},payload:{status:"completed"},occurred_at:"2026-09-28T00:00:00.000Z",accepted_at:"2026-09-28T00:00:01.000Z"});

test("append/read is company isolated and history is immutable",async()=>{
 const {storage,store}=await fixture();await store.append(evidence("ev-a"));await store.append(evidence("ev-b","co-b"));
 assert.equal((await store.get("co-a","ev-a")).company_id,"co-a");assert.equal(await store.get("co-b","ev-a"),null);
 await assert.rejects(()=>storage.query("UPDATE evidence SET payload='{}' WHERE id=$1",["ev-a"]),/business-evidence-immutable/);
 await assert.rejects(()=>storage.query("DELETE FROM evidence WHERE id=$1",["ev-a"]),/business-evidence-immutable/);
 await storage.close();
});

test("supersession requires same-company existing subject parent",async()=>{
 const {storage,store}=await fixture();await store.append(evidence("ev-a"));
 await assert.rejects(()=>store.append({...evidence("ev-c"),supersedes_evidence_id:"missing"}),/parent-missing/);
 await assert.rejects(()=>store.append({...evidence("ev-c","co-b"),supersedes_evidence_id:"ev-a"}),/parent-missing/);
 await store.append({...evidence("ev-c"),event_type:"job.status.corrected",supersedes_evidence_id:"ev-a",payload:{status:"in_progress"}});
 assert.equal((await store.acceptedForSubject("co-a","job","job-1")).length,2);
 await storage.close();
});
