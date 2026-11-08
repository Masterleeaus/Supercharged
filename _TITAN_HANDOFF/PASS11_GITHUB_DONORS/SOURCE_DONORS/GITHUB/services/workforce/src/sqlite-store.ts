import type { StorageClient } from "../../../packages/storage/src/index.js";
import type { CompanyId,WorkId,WorkItem,WorkforceEvent,WorkforceStore,WorkforceWorker,WorkforceWorkerStore,WorkerId } from "./index.js";
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
/** Canonical production workforce persistence over Titan's SQLite-first StorageClient. */
export class SqliteWorkforceStore implements WorkforceStore, WorkforceWorkerStore {
 constructor(private readonly storage:StorageClient){}
 async migrate(){
  await this.storage.query(`CREATE TABLE IF NOT EXISTS workforce_work_items (company_id TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, assignee TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (company_id, work_id))`);
  await this.storage.query(`CREATE INDEX IF NOT EXISTS workforce_work_state_idx ON workforce_work_items(company_id,state,updated_at)`);
  await this.storage.query(`CREATE TABLE IF NOT EXISTS workforce_events (event_seq INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, work_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, actor TEXT, payload TEXT NOT NULL)`);
  await this.storage.query(`CREATE INDEX IF NOT EXISTS workforce_event_work_idx ON workforce_events(company_id,work_id,event_seq)`);
  await this.storage.query(`CREATE TABLE IF NOT EXISTS workforce_workers (company_id TEXT NOT NULL, worker_id TEXT NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL, team_id TEXT, manager_id TEXT, active INTEGER NOT NULL, PRIMARY KEY (company_id, worker_id))`);
  await this.storage.query(`CREATE INDEX IF NOT EXISTS workforce_worker_team_idx ON workforce_workers(company_id,team_id,active)`);
 }
 async get(c:CompanyId,w:WorkId){const r=await this.storage.query<{payload:string}>(`SELECT payload FROM workforce_work_items WHERE company_id = $1 AND work_id = $2`,[c,w]);return r.rows[0]?JSON.parse(r.rows[0].payload) as WorkItem:undefined}
 async create(i:WorkItem){const r=await this.storage.query("INSERT INTO workforce_work_items(company_id,work_id,payload,state,assignee,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,work_id) DO NOTHING",[i.company_id,i.work_id,JSON.stringify(i),i.state,i.assignee??null,i.updated_at]);return r.rowCount===1}
 async put(i:WorkItem){await this.storage.query(`INSERT INTO workforce_work_items(company_id,work_id,payload,state,assignee,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,work_id) DO UPDATE SET payload=excluded.payload,state=excluded.state,assignee=excluded.assignee,updated_at=excluded.updated_at`,[i.company_id,i.work_id,JSON.stringify(i),i.state,i.assignee??null,i.updated_at])}
 async list(c:CompanyId){const r=await this.storage.query<{payload:string}>(`SELECT payload FROM workforce_work_items WHERE company_id = $1 ORDER BY updated_at DESC`,[c]);return r.rows.map(x=>JSON.parse(x.payload) as WorkItem)}
 async appendEvent(e:WorkforceEvent){await this.storage.query(`INSERT INTO workforce_events(company_id,work_id,type,at,actor,payload) VALUES($1,$2,$3,$4,$5,$6)`,[e.company_id,e.work_id,e.type,e.at,e.actor??null,JSON.stringify(e.data??{})])}
 async getWorker(c:CompanyId,w:WorkerId){const r=await this.storage.query<{payload:string}>(`SELECT payload FROM workforce_workers WHERE company_id = $1 AND worker_id = $2`,[c,w]);return r.rows[0]?JSON.parse(r.rows[0].payload) as WorkforceWorker:undefined}
 async putWorker(w:WorkforceWorker){
  if(w.human_identity_ref!==undefined&&(!clean(w.human_identity_ref)||w.kind!=="human"))throw new Error("human-identity-reference-invalid");
  await this.storage.query(`INSERT INTO workforce_workers(company_id,worker_id,payload,kind,team_id,manager_id,active) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,worker_id) DO UPDATE SET payload=excluded.payload,kind=excluded.kind,team_id=excluded.team_id,manager_id=excluded.manager_id,active=excluded.active`,[w.company_id,w.worker_id,JSON.stringify(w),w.kind,w.team_id??null,w.manager_id??null,w.active?1:0])
 }
 async listWorkers(c:CompanyId){const r=await this.storage.query<{payload:string}>(`SELECT payload FROM workforce_workers WHERE company_id = $1 ORDER BY worker_id`,[c]);return r.rows.map(x=>JSON.parse(x.payload) as WorkforceWorker)}

 async findHumanByIdentityRef(c:CompanyId,identityRef:string){
  const ref=clean(identityRef);
  if(!ref)throw new Error("human-identity-reference-required");
  const r=await this.storage.query<{payload:string}>(`SELECT payload FROM workforce_workers WHERE company_id=$1 AND kind='human' AND json_extract(payload,'$.human_identity_ref')=$2 ORDER BY worker_id`,[c,ref]);
  if(r.rowCount>1)throw new Error("human-identity-binding-ambiguous");
  return r.rows[0]?JSON.parse(r.rows[0].payload) as WorkforceWorker:undefined;
 }

 /** Compare-and-set reassignment for READY work. The assignment event and row
  * update share one transaction so a dispatcher claim cannot race the change. */
 async reassignReady(input:{company_id:CompanyId;work_id:WorkId;expected_assignee?:WorkerId|null;target_worker_id:WorkerId;manager_worker_id:WorkerId;actor_id:string;reason:string;operation_id:string;at?:string;signal?:AbortSignal;authorizeCurrent?:(transaction:StorageClient,item:WorkItem,target:WorkforceWorker)=>Promise<void>}){
  const company_id=clean(input.company_id),work_id=clean(input.work_id),target=clean(input.target_worker_id),actor=clean(input.actor_id);
  const manager=clean(input.manager_worker_id),operation=clean(input.operation_id),reason=clean(input.reason);
  if(!company_id||!work_id||!target||!actor||!manager||!operation||!reason)throw new Error("workforce-reassignment-input-invalid");
  const at=input.at??new Date().toISOString();
  return this.storage.transaction(async tx=>{
   input.signal?.throwIfAborted();
   const result=await tx.query<{payload:string;state:string;assignee:string|null;updated_at:string}>(`SELECT payload,state,assignee,updated_at FROM workforce_work_items WHERE company_id=$1 AND work_id=$2`,[company_id,work_id]);
   const row=result.rows[0];
   if(!row)throw new Error("work-not-found-in-company");
   if(row.state!=="READY")throw new Error("work-reassignment-requires-ready-work");
   const item=JSON.parse(row.payload) as WorkItem;
   if((item.assignee??null)!==(input.expected_assignee??null)||row.assignee!==(input.expected_assignee??null))throw new Error("work-reassignment-assignee-changed");
   if(row.assignee===target)throw new Error("work-reassignment-noop");
   const workerResult=await tx.query<{payload:string}>(`SELECT payload FROM workforce_workers WHERE company_id=$1 AND worker_id=$2`,[company_id,target]);
   const worker=workerResult.rows[0]?JSON.parse(workerResult.rows[0].payload) as WorkforceWorker:undefined;
   if(!worker)throw new Error("workforce-target-worker-not-found");
   if(!worker.active)throw new Error("workforce-target-worker-inactive");
   if((item.required_capabilities??[]).some(capability=>!worker.capabilities.includes(capability)))throw new Error("workforce-target-worker-ineligible");
   input.signal?.throwIfAborted();
   await input.authorizeCurrent?.(tx,item,worker);
   input.signal?.throwIfAborted();
   const updated:WorkItem={...item,assignee:target,updated_at:at};
   const changed=await tx.query(`UPDATE workforce_work_items SET payload=$1,assignee=$2,updated_at=$3 WHERE company_id=$4 AND work_id=$5 AND state='READY' AND updated_at=$6 AND assignee IS $7`,[JSON.stringify(updated),target,at,company_id,work_id,row.updated_at,row.assignee]);
   if(changed.rowCount!==1)throw new Error("work-reassignment-conflict");
   const event:WorkforceEvent={company_id,type:"work.reassigned",work_id,at,actor,data:{actor_id:actor,manager_worker_id:manager,from_assignee:row.assignee,target_worker_id:target,reason,operation_id:operation}};
   await tx.query(`INSERT INTO workforce_events(company_id,work_id,type,at,actor,payload) VALUES($1,$2,$3,$4,$5,$6)`,[company_id,work_id,event.type,at,actor,JSON.stringify(event.data)]);
   input.signal?.throwIfAborted();
   return updated;
  });
 }

 async appendAcceptedEvidenceRef(c:CompanyId,w:WorkId,assignee:WorkerId,evidenceId:string,transaction?:StorageClient){
  if(!clean(evidenceId))throw new Error("accepted-evidence-id-required");
  const append=async(tx:StorageClient)=>{
   const found=await tx.query<{payload:string}>(`SELECT payload FROM workforce_work_items WHERE company_id=$1 AND work_id=$2 AND assignee=$3`,[c,w,assignee]);
   const row=found.rows[0];
   if(!row)throw new Error("accepted-evidence-work-assignment-changed");
   const item=JSON.parse(row.payload) as WorkItem;
   if(!item.evidence_refs.includes(evidenceId))item.evidence_refs=[...item.evidence_refs,evidenceId];
   const updated=await tx.query(`UPDATE workforce_work_items SET payload=$1 WHERE company_id=$2 AND work_id=$3 AND assignee=$4`,[JSON.stringify(item),c,w,assignee]);
   if(updated.rowCount!==1)throw new Error("accepted-evidence-work-assignment-changed");
   return item;
  };
  return transaction?append(transaction):this.storage.transaction(append);
 }
}
