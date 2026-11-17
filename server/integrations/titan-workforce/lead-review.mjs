/** Native AgentLabs adapter for Titan's ORIGINAL revenue lifecycle engine.
 * Review-only, fail-closed. Requires a trusted identity/ownership adapter
 * supplied by the separate integration authority; does not read/write a DB.
 */
import {createHash} from 'node:crypto';
import {buildLeadOpportunityLifecycleTransition} from '../titan-revenue/revenue-lead-opportunity-lifecycle.mjs';
import {validateContext,validId,WorkforceAdapterError} from './validation.mjs';

const allowedKeys=Object.freeze(['lead_reference','to_state','client_event_reference']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const requiredPort=(ports,key)=>{
  if(typeof ports?.[key]!=='function')throw new WorkforceAdapterError('revenue_ports_unavailable',503);
  return ports[key].bind(ports);
};
function parse(raw){
  if(!plain(raw)||Object.keys(raw).some(k=>!allowedKeys.includes(k))||
    !validId(raw.lead_reference)||!validId(raw.client_event_reference)||
    typeof raw.to_state!=='string'||!validId(raw.to_state))
    throw new WorkforceAdapterError('lead_transition_invalid_request',422);
  return Object.freeze({lead_reference:raw.lead_reference,to_state:raw.to_state,
    client_event_reference:raw.client_event_reference});
}

/** Return a governable proposal; never updates AgentLabs or Field's lead row. */
export async function previewLeadTransition(raw,authContext,{ports,observedAt}={}){
  const request=parse(raw);
  // These are server-injected ports; never infer the company from a caller's JSON.
  const identity=validateContext(await requiredPort(ports,'resolveIdentity')(authContext));
  const record=await requiredPort(ports,'resolveResource')({context:identity,kind:'lead',reference:request.lead_reference});
  if(!plain(record)||record.verified!==true||record.kind!=='lead'||
    record.company_id!==identity.company_id||record.reference!==request.lead_reference||
    typeof record.state!=='string'||!validId(record.state))
    throw new WorkforceAdapterError('lead_resource_not_verified',403);
  const decision=await requiredPort(ports,'authorize')({context:identity,workflow:'sales',
    resource:{kind:'lead',reference:record.reference},requested_state:request.to_state});
  if(!plain(decision)||decision.allowed!==true||decision.company_id!==identity.company_id)
    throw new WorkforceAdapterError('lead_transition_not_authorized',403);

  const eventKey=createHash('sha256').update(JSON.stringify([
    'agentlabs-lead-intent.v1',identity.company_id,identity.desk_actor_id,
    request.lead_reference,record.state,request.to_state,request.client_event_reference
  ])).digest('hex');
  const when=observedAt??new Date().toISOString();
  if(typeof when!=='string'||!Number.isFinite(Date.parse(when)))
    throw new WorkforceAdapterError('lead_transition_invalid_timestamp');
  let transition;
  try {
    transition=buildLeadOpportunityLifecycleTransition({
      company_id:identity.company_id,kind:'lead',lead_id:record.reference,
      from_state:record.state,to_state:request.to_state,
      provenance:{producer:'agentlabs',source_event_id:eventKey,observed_at:when},
      evidence_refs:[`agentlabs:review:${eventKey}`]
    });
  } catch(error) {
    if(error instanceof TypeError)throw new WorkforceAdapterError('lead_transition_not_allowed',422);
    throw error;
  }
  return Object.freeze({
    schema:'titan.agentlabs.lead-transition-preview.v1',
    event_id:eventKey,company_id:identity.company_id,
    actor_reference:identity.desk_actor_id,
    lead_reference:record.reference,transition,
    execution:'not_executed',delivery:'not_sent',human_review_required:true,
    persistence:'not_requested',source:'agentlabs'
  });
}

/** Native AgentLabs Express route; no database migration or provider execution. */
export function registerLeadPreviewRoute(app,{adminAuthMiddleware,ports,mode}={}){
  if(mode!=='shadow'||typeof adminAuthMiddleware!=='function'||
    ['resolveIdentity','resolveResource','authorize'].some(x=>typeof ports?.[x]!=='function'))
    return Object.freeze({registered:false,reason:'disabled_or_ports_missing'});
  const path='/api/titan-workforce/v1/revenue/leads/preview';
  app.post(path,adminAuthMiddleware,async(req,res)=>{
    res.set('cache-control','no-store');
    if(!Buffer.isBuffer(req.rawBody)||req.rawBody.length>2048)
      return res.status(413).json({error:'invalid_raw_body'});
    try{return res.status(202).json(await previewLeadTransition(req.body,req,{ports}));}
    catch(e){
      if(e instanceof WorkforceAdapterError)return res.status(e.status).json({error:e.code});
      return res.status(503).json({error:'lead_preview_unavailable'});
    }
  });
  return Object.freeze({registered:true,path,execution:'review_only'});
}
