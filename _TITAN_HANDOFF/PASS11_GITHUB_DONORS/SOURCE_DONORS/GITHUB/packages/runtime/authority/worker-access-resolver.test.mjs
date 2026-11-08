import test from "node:test";
import assert from "node:assert/strict";
import { createSqliteStorage } from "../../storage/src/index.js";
import { SqliteWorkerAccessStore, WorkerAccessResolver } from "./worker-access-resolver.mjs";

async function fixture(){
 const storage=createSqliteStorage(":memory:");
 await storage.query(`CREATE TABLE worker_access_assignments(company_id TEXT NOT NULL,assignment_id TEXT NOT NULL,worker_id TEXT NOT NULL,permissions TEXT NOT NULL,entitlements TEXT NOT NULL,status TEXT NOT NULL,granted_by TEXT,granted_at TEXT NOT NULL,expires_at TEXT,supersedes_assignment_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(company_id,assignment_id))`);
 const store=new SqliteWorkerAccessStore(storage); return {storage,store,resolver:new WorkerAccessResolver({store})};
}
const grant=(company_id="co-a",id="grant-1")=>({company_id,assignment_id:id,worker_id:"worker-1",permissions:["booking.write"],entitlements:["booking"],status:"active",granted_by:"human-1",granted_at:"2026-09-28T00:00:00Z",expires_at:"2026-09-29T00:00:00Z"});

test("worker access is company scoped",async()=>{const {storage,store,resolver}=await fixture();await store.append(grant());assert.deepEqual((await resolver.resolve({company_id:"co-a",worker_id:"worker-1",input:{now:"2026-09-28T01:00:00Z"}})).permissions,["booking.write"]);assert.deepEqual((await resolver.resolve({company_id:"co-b",worker_id:"worker-1"})).permissions,[]);await storage.close();});
test("expired or revoked access resolves empty",async()=>{const a=await fixture();await a.store.append({...grant(),expires_at:"2026-09-28T00:30:00Z"});assert.deepEqual((await a.resolver.resolve({company_id:"co-a",worker_id:"worker-1",input:{now:"2026-09-28T01:00:00Z"}})).permissions,[]);await a.storage.close();const b=await fixture();await b.store.append({...grant(),status:"revoked"});assert.deepEqual((await b.resolver.resolve({company_id:"co-a",worker_id:"worker-1"})).permissions,[]);await b.storage.close();});
test("supersession cannot cross workers or missing parents",async()=>{const {storage,store}=await fixture();await store.append(grant());await assert.rejects(()=>store.append({...grant("co-a","grant-2"),worker_id:"worker-2",supersedes_assignment_id:"grant-1"}),/worker-mismatch/);await assert.rejects(()=>store.append({...grant("co-a","grant-3"),supersedes_assignment_id:"missing"}),/parent-missing/);await storage.close();});
