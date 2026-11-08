import { executionRequestFingerprint, executionAuthorityFailure } from './execution-gateway.mjs';

/** Lifecycle persistence for the canonical gateway. It never grants authority. */
export class InMemoryExecutionLifecycleStore {
  #records = new Map();
  #events = new Map();
  async get(company_id, execution_id) { return clone(this.#records.get(key(company_id, execution_id)) ?? null); }
  async find(execution_id) { return clone([...this.#records.values()].find(record => record.execution_id === execution_id) ?? null); }
  async put(record) { this.#records.set(key(record.company_id, record.execution_id), clone(record)); return clone(record); }
  async append(event) { const k=key(event.company_id,event.execution_id); this.#events.set(k,[...(this.#events.get(k)??[]),clone(event)]); return clone(event); }
  async history(company_id, execution_id) { return clone(this.#events.get(key(company_id, execution_id)) ?? []); }
  async create(record, event) {
    const k=key(record.company_id,record.execution_id);
    if (this.#records.has(k)) return false;
    this.#records.set(k,clone(record));
    this.#events.set(k,[clone(event)]);
    return true;
  }
  async claim(previous,next,event) {
    const k=key(previous.company_id,previous.execution_id);
    if (JSON.stringify(this.#records.get(k))!==JSON.stringify(previous)) return false;
    this.#records.set(k,clone(next));
    this.#events.set(k,[...(this.#events.get(k)??[]),clone(event)]);
    return true;
  }
}

/** Atomic company-scoped lifecycle records/events over canonical StorageClient. */
export class SqliteExecutionLifecycleStore {
  constructor(storage) { if (!storage?.transaction) throw new Error('execution-lifecycle-storage-required'); this.storage=storage; }
  async migrate() {
    await this.storage.query('CREATE TABLE IF NOT EXISTS execution_lifecycle_records (company_id TEXT NOT NULL, execution_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(company_id,execution_id))');
    await this.storage.query('CREATE TABLE IF NOT EXISTS execution_lifecycle_events (event_seq INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, execution_id TEXT NOT NULL, payload TEXT NOT NULL)');
    await this.storage.query('CREATE INDEX IF NOT EXISTS execution_lifecycle_event_scope ON execution_lifecycle_events(company_id,execution_id,event_seq)');
  }
  async get(company_id,execution_id) { const result=await this.storage.query('SELECT payload FROM execution_lifecycle_records WHERE company_id=$1 AND execution_id=$2',[company_id,execution_id]); return result.rows[0]?JSON.parse(result.rows[0].payload):null; }
  async find(execution_id) { const result=await this.storage.query('SELECT payload FROM execution_lifecycle_records WHERE execution_id=$1 LIMIT 1',[execution_id]); return result.rows[0]?JSON.parse(result.rows[0].payload):null; }
  async history(company_id,execution_id) { const result=await this.storage.query('SELECT payload FROM execution_lifecycle_events WHERE company_id=$1 AND execution_id=$2 ORDER BY event_seq',[company_id,execution_id]); return result.rows.map(row=>JSON.parse(row.payload)); }
  async create(record,event) {
    return this.storage.transaction(async tx=>{
      const result=await tx.query('INSERT INTO execution_lifecycle_records(company_id,execution_id,payload) VALUES($1,$2,$3) ON CONFLICT(company_id,execution_id) DO NOTHING',[record.company_id,record.execution_id,JSON.stringify(record)]);
      if(result.rowCount!==1)return false;
      await tx.query('INSERT INTO execution_lifecycle_events(company_id,execution_id,payload) VALUES($1,$2,$3)',[record.company_id,record.execution_id,JSON.stringify(event)]);
      return true;
    });
  }
  async claim(previous,next,event) {
    return this.storage.transaction(async tx=>{
      const result=await tx.query('UPDATE execution_lifecycle_records SET payload=$1 WHERE company_id=$2 AND execution_id=$3 AND payload=$4',[JSON.stringify(next),previous.company_id,previous.execution_id,JSON.stringify(previous)]);
      if(result.rowCount!==1)return false;
      await tx.query('INSERT INTO execution_lifecycle_events(company_id,execution_id,payload) VALUES($1,$2,$3)',[next.company_id,next.execution_id,JSON.stringify(event)]);
      return true;
    });
  }
}

export class GovernedExecutionRecovery {
  constructor({gateway,store=new InMemoryExecutionLifecycleStore(),now=()=>new Date().toISOString()}={}) {
    if(!gateway||typeof gateway.execute!=='function')throw new Error('execution-gateway-required');
    if(!store.create||!store.claim)throw new Error('execution-lifecycle-atomic-store-required');
    this.gateway=gateway;this.store=store;this.now=now;this.active=new Set();
  }
  async start(request) {
    validateIdentity(request);
    const existing=await this.store.get(request.company_id,request.execution_id);
    if(existing){assertRequest(existing,request);return existing;}
    const record={schema:'titan.execution.lifecycle/v1',execution_id:request.execution_id,company_id:request.company_id,status:'READY',kind:request.compensation_of?'COMPENSATION':'PRIMARY',attempt:0,parent_execution_id:request.compensation_of??null,request_fingerprint:executionRequestFingerprint(request),request:persistedRequest(request),updated_at:this.now()};
    if(!await this.store.create(record,{...record,type:'STARTED'})) {
      const current=await this.store.get(request.company_id,request.execution_id);assertRequest(current,request);return current;
    }
    return record;
  }
  async resume(execution_id,request) { return this.attempt(execution_id,request,false); }
  async retry(execution_id,request) { return this.attempt(execution_id,request,true); }
  async attempt(execution_id,request,retry) {
    const record=await this.requireRecord(execution_id,request);
    assertRequest(record,request);
    if(isTerminal(record.status)) {
      const authorityFailure=executionAuthorityFailure(request);
      if(authorityFailure)return {state:'DENIED',execution_id,company_id:record.company_id,failure:{code:authorityFailure}};
      if(retry)throw new Error('terminal-execution-cannot-retry');
      return {...clone(record.result??{state:record.status,execution_id,company_id:record.company_id}),duplicate:true};
    }
    const k=key(record.company_id,execution_id);
    if(this.active.has(k))return {state:'UNCERTAIN',execution_id,company_id:record.company_id,failure:{code:'EXECUTION_IN_PROGRESS'}};
    const execute=record.status==='READY'||(record.status==='FAILED'&&record.result?.non_execution_proven===true);
    const method=execute?'execute':'reconcile';
    if(typeof this.gateway[method]!=='function')throw new Error('execution-reconciliation-required');
    this.active.add(k);
    try {
      await this.transition(record,request,retry?'RETRY_REQUESTED':'RESUMED',execute?'RUNNING':'RECONCILING',{attempt:record.attempt+1});
      let result;
      try { result=await this.gateway[method](Object.freeze({...request,company_id:record.company_id,execution_id:record.execution_id,provider_id:record.result?.provider??request.provider_id,reconciliation:request.reconciliation??(record.result?.evidence?{external_ref:record.result.evidence.external_ref,observed_result:record.result.evidence.observed_result}:undefined)})); }
      catch(error) {
        // Throws after dispatch provide no proof that the provider did not mutate.
        result={state:'UNCERTAIN',execution_id,company_id:record.company_id,failure:{code:error?.code??'EXECUTION_OUTCOME_UNKNOWN',message:String(error?.message??error)}};
      }
      await this.transition(record,request,'COMPLETED',result?.state??'UNCERTAIN',{result:clone(result)});
      return result;
    } finally { this.active.delete(k); }
  }
  async compensate(execution_id,request) {
    await this.requireRecord(execution_id,request,false);
    validateIdentity(request);
    if(request.execution_id===execution_id)throw new Error('compensation-requires-new-execution-id');
    const compensationRequest={...request,compensation_of:execution_id};
    const compensation=await this.start(compensationRequest);
    if(compensation.status==='READY')await this.transition(compensation,compensationRequest,'COMPENSATION_REQUESTED','READY',{parent_execution_id:execution_id});
    return this.resume(compensation.execution_id,compensationRequest);
  }
  async get(execution_id,company_id) { return this.store.get(company_id,execution_id); }
  async history(execution_id,company_id) { return this.store.history(company_id,execution_id); }
  async requireRecord(execution_id,request,bind=true) {
    validateIdentity({...request,execution_id});
    if(bind&&request.execution_id!==execution_id)throw new Error('execution-identity-mismatch');
    const record=await this.store.get(request.company_id,execution_id);
    if(!record) {
      if(await this.store.find?.(execution_id))throw new Error('execution-company-context-mismatch');
      throw new Error(`execution-not-found:${execution_id}`);
    }
    return record;
  }
  async transition(record,request,type,status,changes={}) {
    const next={...record,...changes,status,updated_at:this.now()};
    if(!await this.store.claim(record,next,{...next,type,request_id:request.request_id??request.execution_id}))throw new Error('execution-lifecycle-claim-conflict');
    Object.assign(record,next);return next;
  }
}

function persistedRequest(request) {
  const fields=['execution_id','company_id','capability','input','idempotency_key','actor_id','conversation_id','request_id','operation_id','trace_id','correlation_id','interaction_id','work_id','run_id','agent_id'];
  return Object.fromEntries(fields.filter(field=>request[field]!==undefined).map(field=>[field,clone(request[field])]));
}
function key(company_id,execution_id) { return JSON.stringify([company_id,execution_id]); }
function clone(value) { return value==null?value:structuredClone(value); }
function isTerminal(status) { return ['VERIFIED','DENIED'].includes(status); }
function validateIdentity(request) { for(const field of ['execution_id','company_id','capability','idempotency_key'])if(!request?.[field])throw new Error(`missing-${field}`); }
function assertRequest(record,request) { if(record.request_fingerprint!==executionRequestFingerprint(request))throw new Error('execution-request-identity-mismatch'); }
