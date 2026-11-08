import {lookupWorkflow,CATALOG_VERSION} from './catalog.mjs';
import {validatePreviewRequest,validateContext,verifyResource,WorkforceAdapterError,
  fingerprint,requestHash} from './validation.mjs';
function needPort(ports,name){
  if(typeof ports?.[name]!=='function')throw new WorkforceAdapterError('workforce_ports_unavailable',503);
  return ports[name].bind(ports);
}
/**
 * Produce one review-only proposal. No AI calls, storage, provider delivery or Field writes.
 * Trusted context MUST be resolved from the authenticated request by a server port,
 * not inferred from any request-body company_id or a first available user.
 */
export async function previewWorkforceAction(raw,authContext,{ports}={}){
  const request=validatePreviewRequest(raw);
  const resolveIdentity=needPort(ports,'resolveIdentity');
  const resolveResource=needPort(ports,'resolveResource');
  const authorize=needPort(ports,'authorize');
  const context=validateContext(await resolveIdentity(authContext));
  const resource=verifyResource(await resolveResource({context,kind:lookupWorkflow(request.workflow).resource,
    reference:request.resource_reference}),request.workflow,context,request.resource_reference);
  const decision=await authorize({context,workflow:request.workflow,resource});
  if(!decision||decision.allowed!==true||decision.company_id!==context.company_id)
    throw new WorkforceAdapterError('workforce_action_not_authorized',403);
  const spec=lookupWorkflow(request.workflow);
  return Object.freeze({schema:'titan.workforce.review-proposal.v1',catalog:CATALOG_VERSION,
    event_id:fingerprint(context.company_id,context.desk_actor_id,request),payload_hash:requestHash(request),
    company_id:context.company_id,actor_reference:context.desk_actor_id,
    workflow:request.workflow,owner:spec.owner,resource,
    requested_outcome:spec.outcome,
    execution:'not_executed',human_review_required:true,
    source:'agentlabs',client_request_reference:request.client_request_reference});
}
