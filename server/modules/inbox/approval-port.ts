/**
 * Reuses the canonical ApprovalService methods without constructing a second
 * approval engine. The tx claim is intentionally adapted at the Inbox boundary:
 * existing Inbox SQL returns a boolean, while ApprovalService expects a row.
 * A pre-read approval snapshot is used solely as the returned marker; the claim
 * itself remains the PostgreSQL conditional update inside the pinned transaction.
 */
import {assertCompanyId} from '../../infrastructure/database/tenant-context.ts';
import type {ApprovalPort,ApprovalRecord,ApprovalGateRequest,ApprovalGateResult} from './ports.ts';
type CanonicalApprovalView = {
 id:string;action:string;params:Record<string,unknown>;status:string;
};
export interface CanonicalApprovalPortSource {
 gateAction(request:ApprovalGateRequest):Promise<{status:string;approval:{id:string};decision:string;policyId:string|null}>;
 getApproval(companyId:string,id:string):Promise<CanonicalApprovalView|null>;
 recordExecuted(companyId:string,approval:CanonicalApprovalView,actorId:string|null):Promise<void>;
}
function toInboxRecord(value:CanonicalApprovalView):ApprovalRecord{
 if(!value||typeof value.id!=='string'||typeof value.action!=='string'||!value.params||
    typeof value.params!=='object'||Array.isArray(value.params))
   throw Error('inbox: canonical approval record incomplete');
 if(!['pending','approved','rejected','expired'].includes(value.status))
   throw Error('inbox: unsupported approval state '+String(value.status));
 return{id:value.id,action:value.action,params:value.params,status:value.status as ApprovalRecord['status']};
}
export function createInboxApprovalPort(source:CanonicalApprovalPortSource):ApprovalPort {
 if(!source||typeof source.gateAction!=='function'||typeof source.getApproval!=='function'||
    typeof source.recordExecuted!=='function')throw Error('inbox: canonical approval service required');
 return {
  async gateAction(request){
   const co=assertCompanyId(request.companyId);
   const result=await source.gateAction({...request,companyId:co});
   if(!result?.approval?.id||!['pending','approved','rejected','expired'].includes(result.status))
    throw Error('inbox: canonical approval gate returned invalid state');
   return result as ApprovalGateResult;
  },
  async getApproval(companyId,id){
   const row=await source.getApproval(assertCompanyId(companyId),id);
   return row?toInboxRecord(row):null;
  },
  async markExecuted(companyId,id,_actorId,tx){
   const co=assertCompanyId(companyId);
   if(!tx||typeof tx.claimExecuted!=='function')
    throw Error('inbox: atomic PostgreSQL approval claim required');
   const current=await source.getApproval(co,id);
   if(!current||current.status!=='approved')return null;
   if(!await tx.claimExecuted(co,id,new Date()))return null;
   return toInboxRecord(current);
  },
  async recordExecuted(companyId,approval,actorId){
   // An executed audit is written only after the message transaction commits.
   const co=assertCompanyId(companyId);
   const row=await source.getApproval(co,approval.id);
   if(!row)throw Error('inbox: executed approval missing for audit');
   await source.recordExecuted(co,row,actorId);
  },
 };
}
