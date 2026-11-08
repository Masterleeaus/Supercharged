import { randomUUID } from 'node:crypto';

export const RUN_STATES=Object.freeze(['QUEUED','RUNNING','WAITING_TOOL','WAITING_AGENT','WAITING_USER','WAITING_APPROVAL','WAITING_USER_AUTH','WAITING_MFA','WAITING_EXTERNAL','SUSPENDED','COMPLETED','FAILED','CANCELLED']);
const TERMINAL=new Set(['COMPLETED','FAILED','CANCELLED']);
const EXECUTION_WAITS=new Set(['WAITING_APPROVAL','WAITING_USER_AUTH','WAITING_MFA','WAITING_EXTERNAL']);
const TRANSITIONS=Object.freeze({
 QUEUED:['RUNNING','CANCELLED'], RUNNING:['WAITING_TOOL','WAITING_AGENT','WAITING_USER','WAITING_APPROVAL','WAITING_USER_AUTH','WAITING_MFA','WAITING_EXTERNAL','SUSPENDED','COMPLETED','FAILED','CANCELLED'],
 WAITING_TOOL:['RUNNING','WAITING_APPROVAL','WAITING_USER_AUTH','WAITING_MFA','WAITING_EXTERNAL','FAILED','CANCELLED'], WAITING_AGENT:['RUNNING','FAILED','CANCELLED'], WAITING_USER:['RUNNING','CANCELLED'], WAITING_APPROVAL:['RUNNING','FAILED','CANCELLED'], WAITING_USER_AUTH:['RUNNING','FAILED','CANCELLED'], WAITING_MFA:['RUNNING','FAILED','CANCELLED'], WAITING_EXTERNAL:['RUNNING','FAILED','CANCELLED'], SUSPENDED:['RUNNING','CANCELLED'], COMPLETED:[], FAILED:[], CANCELLED:[]
});
const required=(v,code)=>{const s=String(v??'').trim();if(!s)throw new Error(code);return s;};
const cancellationStringFields=['interaction_id','client_message_id','request_id','operation_id','trace_id','correlation_id','idempotency_key','session_id'];
function cancellationReceipt(run,metadata,reason,requested_at){
 if(metadata!==undefined&&(!metadata||typeof metadata!=='object'||Array.isArray(metadata)))throw new Error('runtime-cancellation-metadata-invalid');
 if(metadata?.actor_id!==undefined&&metadata.actor_id!==run.actor_id)throw new Error('runtime-cancellation-actor-conflict');
 if(typeof reason!=='string'||!reason.trim()||reason.length>1024||/[\u0000-\u001f\u007f]/.test(reason))throw new Error('runtime-cancellation-reason-invalid');
 const receipt={actor_id:run.actor_id,requested_at,reason};
 for(const field of cancellationStringFields){const value=metadata?.[field];if(value===undefined)continue;if(typeof value!=='string'||!value.trim()||value.length>1024||/[\u0000-\u001f\u007f]/.test(value))throw new Error('runtime-cancellation-metadata-invalid');receipt[field]=value;}
 const contextRevision=metadata?.context_revision;
 if(contextRevision!==undefined){if(typeof contextRevision==='string'){if(!contextRevision.trim()||contextRevision.length>1024||/[\u0000-\u001f\u007f]/.test(contextRevision))throw new Error('runtime-cancellation-metadata-invalid');receipt.context_revision=contextRevision;}else if(typeof contextRevision==='number'&&Number.isFinite(contextRevision))receipt.context_revision=contextRevision;else throw new Error('runtime-cancellation-metadata-invalid');}
 return receipt;
}
export function normalizeCompanyId(input){const company_id=input?.company_id??input?.tenant_company_id??input?.tenant_id;const id=required(company_id,'runtime-company-id-required');if(input?.company_id&&input?.tenant_company_id&&String(input.company_id)!==String(input.tenant_company_id))throw new Error('runtime-company-id-conflict');if(input?.company_id&&input?.tenant_id&&String(input.company_id)!==String(input.tenant_id))throw new Error('runtime-company-id-conflict');return id;}
export function assertTransition(from,to){if(!RUN_STATES.includes(to))throw new Error(`runtime-state-invalid:${to}`);if(!TRANSITIONS[from]?.includes(to))throw new Error(`runtime-transition-invalid:${from}->${to}`);return true;}
export class InMemoryRunStore {#runs=new Map();async create(run){if(this.#runs.has(run.run_id))throw new Error('runtime-run-exists');this.#runs.set(run.run_id,structuredClone(run));return this.get(run.company_id,run.run_id);}async get(company_id,run_id){const r=this.#runs.get(run_id);if(!r||r.company_id!==company_id)return null;return structuredClone(r);}async save(run){const current=this.#runs.get(run.run_id);if(current&&current.company_id!==run.company_id)throw new Error('runtime-company-boundary');this.#runs.set(run.run_id,structuredClone(run));return structuredClone(run);}async claimResume(previous,next){const current=this.#runs.get(previous.run_id);if(JSON.stringify(current)!==JSON.stringify(previous))return false;this.#runs.set(next.run_id,structuredClone(next));return true;}async findRecoverableByWork(company_id,work_id){const runs=[...this.#runs.values()].filter(r=>r.company_id===company_id&&r.work_id===work_id&&!TERMINAL.has(r.state)).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));return runs[0]?structuredClone(runs[0]):null;}async recoverable(){return [...this.#runs.values()].filter(r=>!TERMINAL.has(r.state)).map(r=>structuredClone(r));}}
export class RuntimeEventBus {#listeners=new Set();subscribe(listener){this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}emit(event){for(const listener of this.#listeners)listener(structuredClone(event));}}
export class TitanAgentRuntime {
 constructor({store,modelRouter,capabilities,authorityGateway,contextProvider,eventBus,clock=()=>new Date(),maxTurns=24}={}){if(!store||!modelRouter)throw new Error('runtime-store-and-model-router-required');this.store=store;this.modelRouter=modelRouter;this.capabilities=capabilities;this.authorityGateway=authorityGateway;this.contextProvider=contextProvider;this.events=eventBus??new RuntimeEventBus();this.clock=clock;this.maxTurns=maxTurns;this.activeRuns=new Set();this.activeRunWork=new Map();}
 #event(run,type,data={}){const event={event_id:randomUUID(),type,at:this.clock().toISOString(),company_id:run.company_id,run_id:run.run_id,conversation_id:run.conversation_id,agent_id:run.agent_id,work_id:run.work_id,interaction_id:run.interaction_id,correlation_id:run.correlation_id,request_id:run.request_id,operation_id:run.operation_id,trace_id:run.trace_id,idempotency_key:run.idempotency_key,actor_id:run.actor_id,...data};this.events.emit(event);return event;}
 async #cancelled(run){const current=await this.store.get(run.company_id,run.run_id);if(current?.state==='CANCELLED'){Object.assign(run,current);return true;}return false;}
 async #transition(run,to,detail={}){
  const previous=await this.store.get(run.company_id,run.run_id);
  if(TERMINAL.has(previous?.state)){Object.assign(run,previous);return run;}
  if(previous?.state!==run.state)throw new Error('runtime-transition-conflict');
  assertTransition(run.state,to);run.state=to;run.updated_at=this.clock().toISOString();run.wait=detail.wait??null;run.error=detail.error??null;if(detail.cancellation)run.cancellation=structuredClone(detail.cancellation);
  if(!this.store.claimResume)throw new Error('runtime-atomic-resume-required');
  if(!await this.store.claimResume(previous,run)){
   if(await this.#cancelled(run))return run;
   throw new Error('runtime-transition-conflict');
  }
  this.#event(run,to.startsWith('WAITING_')?'agent.waiting':to==='RUNNING'?'agent.resumed':to==='COMPLETED'?'run.completed':to==='FAILED'?'run.failed':to==='CANCELLED'?'run.cancelled':'run.state',{state:to,wait:run.wait,error:run.error,...(detail.cancellation??{})});return run;
 }
 async start(input){const company_id=normalizeCompanyId(input);const now=this.clock().toISOString();const run={run_id:input.run_id??randomUUID(),company_id,actor_id:required(input.actor_id,'runtime-actor-id-required'),agent_id:required(input.agent_id,'runtime-agent-id-required'),role:String(input.role??'agent'),conversation_id:required(input.conversation_id??input.session_id,'runtime-conversation-id-required'),work_id:input.work_id??null,interaction_id:input.interaction_id??null,correlation_id:input.correlation_id??null,request_id:input.request_id??null,operation_id:input.operation_id??null,trace_id:input.trace_id??null,idempotency_key:input.idempotency_key??null,authenticated_identity:input.authenticated_identity??null,session_id:input.session_id??null,context_revision:input.context_revision??null,authority_context:input.authority_context??null,capability_context:input.capability_context??null,state:'QUEUED',messages:[...(input.messages??[])],turn:0,created_at:now,updated_at:now,wait:null,error:null,result:null};await this.store.create(run);this.#event(run,'run.started',{state:'QUEUED'});return this.resume({company_id,run_id:run.run_id});}
 async findByWork({company_id,work_id}){const company=required(company_id,'runtime-company-id-required');const work=required(work_id,'runtime-work-id-required');if(this.store.findByWork)return this.store.findByWork(company,work);return this.findRecoverableByWork({company_id:company,work_id:work});}
 async findRecoverableByWork({company_id,work_id}){const company=required(company_id,'runtime-company-id-required');const work=required(work_id,'runtime-work-id-required');if(this.store.findRecoverableByWork)return this.store.findRecoverableByWork(company,work);const runs=await this.store.recoverable(company);return runs.filter(r=>r.company_id===company&&r.work_id===work&&!TERMINAL.has(r.state)).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))[0]??null;}
 async resume(input){
  const key=JSON.stringify([input.company_id,input.run_id]);
  if(this.activeRuns.has(key))throw new Error('runtime-run-active');
  this.activeRuns.add(key);
  try{return await this.#resume(input);}finally{this.activeRuns.delete(key);this.activeRunWork.delete(key);}
 }
 async #resume({company_id,run_id,input,continuation}){
  const run=await this.store.get(company_id,run_id);
  if(!run)throw new Error('runtime-run-not-found');
  this.activeRunWork.set(JSON.stringify([company_id,run_id]),JSON.stringify([company_id,run.work_id]));
  if(continuation){
   required(continuation.client_message_id,'runtime-continuation-message-required');required(continuation.fingerprint,'runtime-continuation-fingerprint-required');
   const receipt=run.continuation_receipts?.find(receipt=>receipt.client_message_id===continuation.client_message_id);
   if(receipt){if(receipt.fingerprint!==continuation.fingerprint)throw new Error('runtime-continuation-replay-conflict');return run;}
  }
  if(TERMINAL.has(run.state))throw new Error('runtime-run-terminal');
  // In-flight tool execution may have an unknown external outcome after a crash.
  // Never re-drive it merely because another continuation arrives.
  if(['RUNNING','WAITING_TOOL','WAITING_AGENT'].includes(run.state))throw new Error('runtime-run-busy-or-recovery-required');
  const previous=structuredClone(run);
  const pending=run.wait?.tool_call&&EXECUTION_WAITS.has(run.state)?structuredClone(run.wait):null;
  assertTransition(run.state,'RUNNING');
  if(continuation)run.continuation_receipts=[...(run.continuation_receipts??[]),structuredClone(continuation)];
  if(input)run.messages.push(input);
  run.state='RUNNING';run.updated_at=this.clock().toISOString();run.wait=pending?{...pending,recovery_in_progress:true}:null;run.error=null;
  if(!this.store.claimResume)throw new Error('runtime-atomic-resume-required');
  if(!await this.store.claimResume(previous,run))throw new Error('runtime-resume-conflict');
  this.#event(run,'agent.resumed',{state:'RUNNING',wait:null,error:null});
  if(pending)return this.#resumePendingExecution(run,pending);
  return this.#drive(run,true);
 }
 isWorkActive({company_id,work_id}){return [...this.activeRunWork.values()].includes(JSON.stringify([company_id,work_id]));}
 async recoverInterrupted(input){
  const key=JSON.stringify([input.company_id,input.run_id]);
  if(this.activeRuns.has(key))throw new Error('runtime-run-active');
  this.activeRuns.add(key);
  try{return await this.#recoverInterrupted(input);}finally{this.activeRuns.delete(key);}
 }
 async #recoverInterrupted({company_id,run_id}){
  const run=await this.store.get(company_id,run_id);
  if(!run)throw new Error('runtime-run-not-found');
  if(TERMINAL.has(run.state))return run;
  if(!['RUNNING','WAITING_TOOL','WAITING_EXTERNAL'].includes(run.state))throw new Error('runtime-orphan-recovery-unavailable');
  if(!run.wait?.tool_call||!this.authorityGateway.prepareRecovery)throw new Error('runtime-orphan-recovery-unavailable');
  // The owner must verify durable execution identity and current authority before
  // an orphan is eligible for verification-only continuation. Never rerun a model.
  const pending=await this.authorityGateway.prepareRecovery({company_id:run.company_id,actor_id:run.actor_id,
   agent_id:run.agent_id,run_id:run.run_id,work_id:run.work_id,tool_call:run.wait.tool_call});
  if(!pending?.execution?.execution_id||pending.execution.state!=='UNCERTAIN')throw new Error('runtime-recovery-proof-required');
  if(await this.#cancelled(run))return run;
  if(run.state==='WAITING_EXTERNAL')return run;
  return this.#transition(run,'WAITING_EXTERNAL',{wait:{...pending,recovery_required:true}});
 }
 async cancel({company_id,run_id,reason='cancelled-by-user',cancellation}){const run=await this.store.get(company_id,run_id);if(!run)throw new Error('runtime-run-not-found');if(TERMINAL.has(run.state))return run;const receipt=cancellationReceipt(run,cancellation,reason,this.clock().toISOString());return this.#transition(run,'CANCELLED',{error:{code:'cancelled',message:reason},cancellation:receipt});}
 async #resumePendingExecution(run,pending){try{const call=pending.tool_call;let decision=pending.decision;if(await this.#cancelled(run))return run;if(run.state!=='RUNNING')throw new Error('runtime-resume-state-invalid');if(pending.execution&&this.authorityGateway?.resume){const result=await this.authorityGateway.resume({company_id:run.company_id,run_id:run.run_id,work_id:run.work_id,agent_id:run.agent_id,decision,execution:pending.execution,input:run.messages.at(-1),tool_input:call.arguments,actor_id:run.actor_id,idempotency_key:call.id??`${run.run_id}:${call.name}`});return this.#consumeExecutionResult(run,call,decision,result);}decision=await this.authorityGateway?.authorize?.({company_id:run.company_id,actor_id:run.actor_id,agent_id:run.agent_id,run_id:run.run_id,conversation_id:run.conversation_id,work_id:run.work_id,capability:call.name,input:call.arguments,authority_context:run.authority_context,prior_decision:decision,resume:true});if(await this.#cancelled(run))return run;if(!decision||decision.status==='denied'){run.messages.push({role:'tool',tool_call_id:call.id,name:call.name,error:'authority-denied'});return this.#drive(run,true);}if(decision.status==='approval_required')return this.#transition(run,'WAITING_APPROVAL',{wait:{tool_call:call,decision}});const capability=await this.capabilities?.resolve?.({company_id:run.company_id,name:call.name,agent_id:run.agent_id});if(await this.#cancelled(run))return run;if(!capability)throw new Error(`runtime-tool-unavailable:${call.name}`);const result=await this.authorityGateway.execute({decision,capability,input:call.arguments,idempotency_key:call.id??`${run.run_id}:${call.name}`,company_id:run.company_id,work_id:run.work_id,agent_id:run.agent_id,run_id:run.run_id});return this.#consumeExecutionResult(run,call,decision,result);}catch(error){if(!TERMINAL.has(run.state))await this.#transition(run,'FAILED',{error:{code:error?.code??'runtime-resume-failure',message:String(error?.message??error)}});return run;}}
 async #consumeExecutionResult(run,call,decision,result){if(await this.#cancelled(run))return run;const state=result?.state;if(state==='UNCERTAIN')return this.#transition(run,'WAITING_EXTERNAL',{wait:{tool_call:call,decision,execution:result,recovery_required:true}});if(EXECUTION_WAITS.has(state))return this.#transition(run,state,{wait:{tool_call:call,decision,execution:result}});if(state==='DENIED'){run.messages.push({role:'tool',tool_call_id:call.id,name:call.name,error:result?.failure?.code??'execution-denied'});return this.#drive(run,true);}if(state==='FAILED')throw new Error(result?.failure?.message??'execution-failed');if(state&&state!=='SUCCEEDED'&&state!=='VERIFIED')throw new Error(`runtime-execution-state-unsupported:${state}`);const verified=state==='VERIFIED'||result?.verified===true||result?.verification?.status==='VERIFIED';if(!verified)throw new Error('execution-outcome-unverified');const evidence_ref=result?.evidence_ref??result?.evidence?.evidence_id??null;this.#event(run,'tool.completed',{tool_call_id:call.id,capability:call.name,evidence_ref,verified:true});run.messages.push({role:'tool',tool_call_id:call.id,name:call.name,content:result?.output??result,evidence_ref});if(run.state==='WAITING_TOOL')await this.#transition(run,'RUNNING');return this.#drive(run,true);}
 async #drive(run,alreadyRunning=false){if(!alreadyRunning)await this.#transition(run,'RUNNING');try{while(run.state==='RUNNING'){if(await this.#cancelled(run))return run;if(run.turn++>=this.maxTurns)throw new Error('runtime-turn-limit');const context=await this.contextProvider?.load?.({company_id:run.company_id,actor_id:run.actor_id,agent_id:run.agent_id,conversation_id:run.conversation_id,work_id:run.work_id})??{};if(await this.#cancelled(run))return run;this.#event(run,'reasoning.status',{status:'working'});const response=await this.modelRouter.next({identity:{company_id:run.company_id,actor_id:run.actor_id,agent_id:run.agent_id,role:run.role,run_id:run.run_id,conversation_id:run.conversation_id,work_id:run.work_id},messages:run.messages,context,capability_context:run.capability_context});if(await this.#cancelled(run))return run;if(response?.delta)this.#event(run,'message.delta',{delta:response.delta});if(response?.final!=null){run.result=response.final;run.messages.push({role:'assistant',content:response.final});return this.#transition(run,'COMPLETED');}if(response?.wait){const state=response.wait.state??'WAITING_EXTERNAL';if(!state.startsWith('WAITING_')&&state!=='SUSPENDED')throw new Error('runtime-wait-state-invalid');return this.#transition(run,state,{wait:response.wait});}const calls=Array.isArray(response?.tool_calls)?response.tool_calls:[];if(!calls.length)throw new Error('runtime-model-response-empty');for(const call of calls){this.#event(run,'tool.requested',{tool_call_id:call.id,capability:call.name});await this.#transition(run,'WAITING_TOOL',{wait:{tool_call_id:call.id,capability:call.name,tool_call:call}});if(await this.#cancelled(run))return run;const capability=await this.capabilities?.resolve?.({company_id:run.company_id,name:call.name,agent_id:run.agent_id});if(await this.#cancelled(run))return run;if(!capability){await this.#transition(run,'RUNNING');throw new Error(`runtime-tool-unavailable:${call.name}`);}const decision=await this.authorityGateway?.authorize?.({company_id:run.company_id,actor_id:run.actor_id,agent_id:run.agent_id,run_id:run.run_id,conversation_id:run.conversation_id,work_id:run.work_id,capability:call.name,input:call.arguments,authority_context:run.authority_context});if(await this.#cancelled(run))return run;if(!decision||decision.status==='denied'){await this.#transition(run,'RUNNING');run.messages.push({role:'tool',tool_call_id:call.id,name:call.name,error:'authority-denied'});continue;}if(decision.status==='approval_required'){this.#event(run,'approval.required',{tool_call_id:call.id,capability:call.name,decision_id:decision.decision_id});return this.#transition(run,'WAITING_APPROVAL',{wait:{tool_call:call,decision}});}this.#event(run,'tool.started',{tool_call_id:call.id,capability:call.name});const result=await this.authorityGateway.execute({decision,capability,input:call.arguments,idempotency_key:call.id??`${run.run_id}:${run.turn}:${call.name}`,company_id:run.company_id,work_id:run.work_id,agent_id:run.agent_id,run_id:run.run_id});return await this.#consumeExecutionResult(run,call,decision,result);}}}catch(error){if(run.state==='WAITING_TOOL')await this.#transition(run,'RUNNING');if(!TERMINAL.has(run.state))await this.#transition(run,'FAILED',{error:{code:error?.code??'runtime-failure',message:String(error?.message??error)}});return run;}}
 async recover(){const runs=await this.store.recoverable();return runs.map(r=>({company_id:r.company_id,run_id:r.run_id,state:r.state,wait:r.wait,work_id:r.work_id,conversation_id:r.conversation_id,agent_id:r.agent_id}));}
}
