const required=(v,c)=>{const s=String(v??"").trim();if(!s)throw new Error(c);return s;};
const list=v=>[...new Set((Array.isArray(v)?v:[]).map(x=>String(x).trim()).filter(Boolean))].sort();

export class SqliteWorkerAccessStore {
 constructor(storage){if(!storage?.query)throw new Error("worker-access-storage-required");this.storage=storage;}
 async append(input){
  const company_id=required(input?.company_id,"worker-access-company-required");
  const assignment_id=required(input?.assignment_id,"worker-access-assignment-required");
  const worker_id=required(input?.worker_id,"worker-access-worker-required");
  const status=required(input?.status,"worker-access-status-required");
  const granted_at=required(input?.granted_at,"worker-access-granted-at-required");
  if(input.supersedes_assignment_id){
    const prior=await this.get(company_id,input.supersedes_assignment_id);
    if(!prior)throw new Error("worker-access-supersession-parent-missing");
    if(prior.worker_id!==worker_id)throw new Error("worker-access-supersession-worker-mismatch");
  }
  const record=Object.freeze({...input,company_id,assignment_id,worker_id,status,granted_at,permissions:list(input.permissions),entitlements:list(input.entitlements)});
  await this.storage.query(
   `INSERT INTO worker_access_assignments(company_id,assignment_id,worker_id,permissions,entitlements,status,granted_by,granted_at,expires_at,supersedes_assignment_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
   [company_id,assignment_id,worker_id,JSON.stringify(record.permissions),JSON.stringify(record.entitlements),status,input.granted_by??null,granted_at,input.expires_at??null,input.supersedes_assignment_id??null]
  );
  return record;
 }
 async get(company_id,assignment_id){
  const r=await this.storage.query(`SELECT * FROM worker_access_assignments WHERE company_id=$1 AND assignment_id=$2 LIMIT 1`,[company_id,assignment_id]);
  return r.rows[0]??null;
 }
 async latest({company_id,worker_id,now=new Date().toISOString()}){
  const r=await this.storage.query(
   `SELECT * FROM worker_access_assignments WHERE company_id=$1 AND worker_id=$2 ORDER BY granted_at DESC, created_at DESC LIMIT 1`,
   [required(company_id,"worker-access-company-required"),required(worker_id,"worker-access-worker-required")]
  );
  const row=r.rows[0]; if(!row)return null;
  if(row.status!=="active")return null;
  if(row.expires_at&&Date.parse(row.expires_at)<=Date.parse(now))return null;
  return {...row,permissions:JSON.parse(row.permissions),entitlements:JSON.parse(row.entitlements)};
 }
}

export class WorkerAccessResolver {
 constructor({store}={}){if(!store?.latest)throw new Error("worker-access-store-required");this.store=store;}
 async resolve({company_id,worker_id,input}={}){
  const record=await this.store.latest({company_id,worker_id,now:input?.now});
  return record?Object.freeze({permissions:list(record.permissions),entitlements:list(record.entitlements),assignment_id:record.assignment_id}):Object.freeze({permissions:[],entitlements:[]});
 }
}
