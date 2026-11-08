import crypto from 'node:crypto';

export const EXECUTION_CLASSES = Object.freeze({ NATIVE:'native', CONNECTED:'connected', OPERATED:'operated' });
export const EXECUTION_STATES = Object.freeze({
  REQUESTED:'REQUESTED', AUTHORIZED:'AUTHORIZED', EXECUTING:'EXECUTING', PROVIDER_ACKNOWLEDGED:'PROVIDER_ACKNOWLEDGED', VERIFYING:'VERIFYING', VERIFIED:'VERIFIED',
  SUCCEEDED:'VERIFIED', UNCERTAIN:'UNCERTAIN', FAILED:'FAILED', DENIED:'DENIED', WAITING_APPROVAL:'WAITING_APPROVAL', WAITING_USER_AUTH:'WAITING_USER_AUTH', WAITING_MFA:'WAITING_MFA',
});

export class ExecutionError extends Error { constructor(code,message,details={}) { super(message); this.name='ExecutionError'; this.code=code; this.details=details; } }

/** Bound an adapter call and cancel its transport on timeout or caller abort. */
export function boundedAdapterCall(operation, { timeoutMs = 30_000, signal } = {}) {
  if (typeof operation !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new ExecutionError('INVALID_ADAPTER_TIMEOUT', 'Adapter timeout must be a finite positive timer duration');
  }
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (failed, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed) { controller.abort(value); reject(value); } else resolve(value);
    };
    const abort = () => finish(true,new ExecutionError('ADAPTER_ABORTED', 'Adapter call aborted'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(true,new ExecutionError('ADAPTER_TIMEOUT', 'Adapter call timed out')), timeoutMs);
    Promise.resolve().then(() => { if (!settled) return operation(controller.signal); })
      .then(value => finish(false, value), error => finish(true,error));
  });
}

export function executionRequestFingerprint(request) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ company_id: request.company_id,
    capability: request.capability, input: request.input ?? null, idempotency_key: request.idempotency_key }))).digest('hex');
}

export function executionAuthorityFailure(request) {
  if (request.authority?.status!=='approved') return 'AUTHORITY_REQUIRED';
  if (request.authority.revoked===true) return 'AUTHORITY_REVOKED';
  if (request.authority.expires_at && (!Number.isFinite(Date.parse(request.authority.expires_at)) || Date.parse(request.authority.expires_at)<=Date.now())) return 'AUTHORITY_EXPIRED';
  if (request.risk?.status==='denied') return 'RISK_DENIED';
  return null;
}

/** Canonical governed provider gateway. Provider acknowledgement is never completion. */
export class ExecutionGateway {
  constructor({ providers=[], evidenceSink=async()=>{}, idempotencyStore=null, now=()=>new Date().toISOString(), timeoutMs=30_000 }={}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>2_147_483_647) throw new ExecutionError('INVALID_ADAPTER_TIMEOUT','Invalid provider timeout');
    this.timeoutMs=timeoutMs; this.providers=new Map(); this.evidenceSink=evidenceSink; this.idempotencyStore=idempotencyStore; this.now=now; this.completed=new Map();
    for (const provider of providers) this.registerProvider(provider);
  }
  registerProvider(provider) {
    if (!provider?.id || !provider?.executionClass || typeof provider.execute!=='function') throw new ExecutionError('INVALID_PROVIDER','Provider requires id, executionClass and execute()');
    this.providers.set(provider.id,provider);
  }
  listProviders() { return [...this.providers.values()].map(({id,executionClass,capabilities=[],health})=>({id,executionClass,capabilities:[...capabilities],health:health??'unknown'})); }

  async execute(request) {
    validateRequest(request);
    if (request.authority?.status==='approval_required') return this.waiting(request,EXECUTION_STATES.WAITING_APPROVAL);
    const authorityFailure=executionAuthorityFailure(request);
    if(authorityFailure)return this.denied(request,authorityFailure);

    const key=JSON.stringify([request.company_id,request.idempotency_key]);
    const prior=await this.getCompleted(key);
    if (prior) { this.assertReplay(prior,request); return {...prior,duplicate:true}; }

    const provider=this.selectProvider(request); const startedAt=this.now();
    await this.emitTransition(request,provider,EXECUTION_STATES.REQUESTED,{started_at:startedAt});
    await this.emitTransition(request,provider,EXECUTION_STATES.AUTHORIZED,{});
    await this.emitTransition(request,provider,EXECUTION_STATES.EXECUTING,{});
    let raw;
    try {
      raw=await boundedAdapterCall(signal=>provider.execute(Object.freeze({...request,signal})),this.callOptions(request));
      if (raw?.state===EXECUTION_STATES.WAITING_MFA || raw?.state===EXECUTION_STATES.WAITING_USER_AUTH || raw?.state===EXECUTION_STATES.WAITING_APPROVAL) return this.record(request,provider,raw.state,raw,startedAt);
      await this.emitTransition(request,provider,EXECUTION_STATES.PROVIDER_ACKNOWLEDGED,{external_ref:raw?.external_ref??null});
      await this.emitTransition(request,provider,EXECUTION_STATES.VERIFYING,{});
      if (typeof provider.verify!=='function') throw new ExecutionError('VERIFIER_REQUIRED','Consequential completion requires an independent provider verifier');
      const verification=await boundedAdapterCall(signal=>provider.verify(raw,Object.freeze({...request,signal})),this.callOptions(request));
      const verified=verification===true || verification?.verified===true;
      if (!verified) throw new ExecutionError('OUTCOME_UNVERIFIED','Provider interaction completed but business outcome was not independently verified');
      const payload={...raw,verification:verification===true?(raw?.verification??{verified:true}):verification};
      const result=await this.record(request,provider,EXECUTION_STATES.VERIFIED,payload,startedAt);
      await this.setCompleted(key,result); return result;
    } catch(error) {
      const result=await this.record(request,provider,EXECUTION_STATES.UNCERTAIN,{external_ref:raw?.external_ref??null,observed_result:raw?.result??raw?.observed_result??null,failure:{code:error?.code??'PROVIDER_FAILURE',message:String(error?.message??error)}},startedAt);
      await this.setCompleted(key,result); return result;
    }
  }

  callOptions(request) {
    const timeoutMs=request.timeoutMs??this.timeoutMs;
    if (!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>this.timeoutMs) throw new ExecutionError('INVALID_ADAPTER_TIMEOUT','Request timeout exceeds configured bound');
    return { timeoutMs, signal: request.signal };
  }
  assertReplay(prior,request) {
    if (prior.request_fingerprint!==executionRequestFingerprint(request)) throw new ExecutionError('EXECUTION_IDENTITY_MISMATCH','Idempotency key is bound to a different execution request');
  }
  async reconcile(request) {
    validateRequest(request);
    const authorityFailure=executionAuthorityFailure(request);
    if(authorityFailure)return this.denied(request,authorityFailure);
    const key=JSON.stringify([request.company_id,request.idempotency_key]);
    const prior=await this.getCompleted(key);
    if (prior) { this.assertReplay(prior,request); if (prior.state===EXECUTION_STATES.VERIFIED) return {...prior,duplicate:true}; }
    const provider=this.selectProvider({...request,provider_id:request.provider_id??prior?.provider});
    const startedAt=this.now();
    try {
      if (typeof provider.verify!=='function') throw new ExecutionError('VERIFIER_REQUIRED','Recovery requires an independent provider verifier');
      await this.emitTransition(request,provider,EXECUTION_STATES.VERIFYING,{reconciliation:true});
      const raw=request.reconciliation??{external_ref:prior?.evidence?.external_ref??null,observed_result:prior?.evidence?.observed_result??null};
      const verification=await boundedAdapterCall(signal=>provider.verify(raw,Object.freeze({...request,signal,reconciliation_only:true})),this.callOptions(request));
      if (!(verification===true||verification?.verified===true)) throw new ExecutionError('OUTCOME_UNVERIFIED','Recovery has not independently observed the business outcome');
      const result=await this.record(request,provider,EXECUTION_STATES.VERIFIED,{...raw,verification:verification===true?{verified:true}:verification},startedAt);
      await this.setCompleted(key,result); return result;
    } catch(error) {
      const result=await this.record(request,provider,EXECUTION_STATES.UNCERTAIN,{failure:{code:error?.code??'VERIFICATION_FAILURE',message:String(error?.message??error)}},startedAt);
      await this.setCompleted(key,result); return result;
    }
  }

  async getCompleted(key) { if (this.idempotencyStore?.get) return (await this.idempotencyStore.get(key))??null; return this.completed.get(key)??null; }
  async setCompleted(key,result) { if (this.idempotencyStore?.set) await this.idempotencyStore.set(key,result); else this.completed.set(key,result); }
  selectProvider(request) {
    const candidates=[...this.providers.values()].filter(p=>(p.capabilities??[]).includes(request.capability)&&(!p.company_id||p.company_id===request.company_id)&&p.enabled!==false&&(!request.provider_id||p.id===request.provider_id));
    if (!candidates.length) throw new ExecutionError('NO_PROVIDER',`No provider for ${request.capability}`);
    const pref=request.preferred_execution_classes??[EXECUTION_CLASSES.NATIVE,EXECUTION_CLASSES.CONNECTED,EXECUTION_CLASSES.OPERATED]; candidates.sort((a,b)=>pref.indexOf(a.executionClass)-pref.indexOf(b.executionClass)); return candidates[0];
  }
  waiting(request,state) { return {execution_id:request.execution_id,company_id:request.company_id,state,capability:request.capability}; }
  denied(request,code) { return {execution_id:request.execution_id,company_id:request.company_id,state:EXECUTION_STATES.DENIED,capability:request.capability,failure:{code}}; }
  async emitTransition(request,provider,state,payload) { await this.evidenceSink(this.evidence(request,provider,state,payload,null)); }
  evidence(request,provider,state,payload,startedAt) { return {
    evidence_id:crypto.randomUUID(),execution_id:request.execution_id,company_id:request.company_id,actor_id:request.actor_id??null,agent_id:request.agent_id??null,correlation_id:request.correlation_id??request.work_id??request.run_id??request.execution_id,causation_id:request.causation_id??request.decision_id??null,decision_id:request.decision_id??null,authority_decision_id:request.authority_decision_id??request.decision_id??null,work_id:request.work_id??null,run_id:request.run_id??null,
    capability:request.capability,provider:provider.id,execution_class:provider.executionClass,state,started_at:startedAt,finished_at:this.now(),idempotency_key:request.idempotency_key,
    request_summary:redactRequest(request),external_ref:payload?.external_ref??null,observed_result:redactObserved(payload?.result??payload?.observed_result??null),verification:payload?.verification??null,failure:payload?.failure??null,final_outcome:state===EXECUTION_STATES.VERIFIED?'verified':state===EXECUTION_STATES.FAILED?'failed':null,
  }; }
  async record(request,provider,state,payload,startedAt) { const evidence=this.evidence(request,provider,state,payload,startedAt); await this.evidenceSink(evidence); return {request_fingerprint:executionRequestFingerprint(request),execution_id:request.execution_id,company_id:request.company_id,state,capability:request.capability,provider:provider.id,execution_class:provider.executionClass,evidence}; }
}

function redactRequest(request) { return {capability:request.capability,input:redactObserved(request.input??null),decision_id:request.decision_id??null,work_id:request.work_id??null,run_id:request.run_id??null}; }
function redactObserved(value) { if (value==null) return value; if (Array.isArray(value)) return value.map(redactObserved); if (typeof value!=='object') return value; const out={}; for (const [k,v] of Object.entries(value)) out[k]=/secret|token|password|credential|authorization|cookie/i.test(k)?'[REDACTED]':redactObserved(v); return out; }
function validateRequest(request) {
  for (const field of ['execution_id','company_id','capability','idempotency_key']) if (!request?.[field]) throw new ExecutionError('INVALID_REQUEST',`Missing ${field}`);
  if (request.credential && typeof request.credential!=='object') throw new ExecutionError('RAW_CREDENTIAL_FORBIDDEN','Use a credential handle, never a raw credential');
  if (request.credential?.secret||request.credential?.token||request.credential?.password) throw new ExecutionError('RAW_CREDENTIAL_FORBIDDEN','Credential handles must not contain secrets');
}
