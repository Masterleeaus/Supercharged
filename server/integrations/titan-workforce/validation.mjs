import {createHash} from 'node:crypto';
import {lookupWorkflow} from './catalog.mjs';
export class WorkforceAdapterError extends Error {
  constructor(code,status=422){super(code);this.code=code;this.status=status;}
}
const ID=/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/;
export const validId=v=>typeof v==='string'&&ID.test(v);
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;}
function exact(v,keys,code){
  if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new WorkforceAdapterError(code);
  return v;
}
export function validatePreviewRequest(raw){
  if(typeof raw==='string'&&Buffer.byteLength(raw)>2048)throw new WorkforceAdapterError('preview_too_large',413);
  const o=exact(raw,['workflow','resource_reference','client_request_reference'],'preview_invalid_body');
  if(!lookupWorkflow(o.workflow))throw new WorkforceAdapterError('preview_unknown_workflow');
  if(!validId(o.resource_reference)||!validId(o.client_request_reference))throw new WorkforceAdapterError('preview_invalid_reference');
  // Company identity and resource kind are purposely NOT accepted from the caller.
  return Object.freeze({workflow:o.workflow,resource_reference:o.resource_reference,
    client_request_reference:o.client_request_reference});
}
export function validateContext(context){
  if(!plain(context)||context.trusted!==true||!validId(context.company_id)||!validId(context.desk_actor_id))
    throw new WorkforceAdapterError('authenticated_company_context_required',403);
  return Object.freeze({company_id:context.company_id,desk_actor_id:context.desk_actor_id});
}
export function verifyResource(resolved,workflow,context,reference){
  const spec=lookupWorkflow(workflow);
  if(!plain(resolved)||resolved.verified!==true||resolved.company_id!==context.company_id
    ||resolved.kind!==spec.resource||resolved.reference!==reference)
    throw new WorkforceAdapterError('resource_authority_unverified',403);
  return Object.freeze({kind:resolved.kind,reference:resolved.reference});
}
export function fingerprint(company,actor,request){
  return createHash('sha256').update(JSON.stringify(['desk-workforce.v1',company,actor,
    request.workflow,request.client_request_reference])).digest('hex');
}
export function requestHash(request){
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
