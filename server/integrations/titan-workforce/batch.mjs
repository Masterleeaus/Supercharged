import {previewWorkforceAction} from './proposal.mjs';
import {WorkforceAdapterError} from './validation.mjs';
/** Bounded previews; rejects the whole batch before processing any item. */
export async function previewWorkforceBatch(requests,authContext,{ports,limit=10}={}){
  if(!Array.isArray(requests)||requests.length<1||requests.length>limit||!Number.isInteger(limit)||limit<1||limit>25)
    throw new WorkforceAdapterError('workforce_batch_invalid');
  const results=[];
  for(const request of requests){
    try{results.push({ok:true,proposal:await previewWorkforceAction(request,authContext,{ports})});}
    catch(e){
      if(!(e instanceof WorkforceAdapterError))throw e;
      results.push({ok:false,error:e.code});
    }
  }
  return Object.freeze({schema:'titan.workforce.preview-batch.v1',count:results.length,results});
}
