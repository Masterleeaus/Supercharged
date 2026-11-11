/** Opt-in dispatcher. No network-capable transport exists by default. */
import {assertCompanyId} from '../../infrastructure/database/tenant-context.ts';
import type {OutboxRepository,OutboxTransport} from './outbox-types.ts';
const retryAfter=(attempt:number)=>Math.min(3600,Math.max(10,2**Math.min(attempt,11)*5));
export function createOutboxDispatcher(repo:OutboxRepository,transport:OutboxTransport){
 if(!repo||typeof repo.claim!=='function'||typeof repo.markSent!=='function'||typeof repo.markRetry!=='function'||typeof repo.loadBody!=='function')
  throw Error('outbox: durable repository required');
 if(!transport||typeof transport.send!=='function')throw Error('outbox: explicit idempotent provider transport required');
 return {
  async runOnce(companyId:string,limit=10){
   const co=assertCompanyId(companyId);
   const jobs=await repo.claim(co,limit,120),results={claimed:jobs.length,sent:0,retried:0,dead:0,stale:0};
   for(const job of jobs){
    if(job.companyId!==co||!job.leaseToken)throw Error('outbox: invalid claimed tenant or lease');
    const body=await repo.loadBody(co,job.messageId);
    if(body===null){
     if(await repo.markRetry(co,job.id,job.leaseToken,60,'message_no_longer_queued',true))results.dead++;
     else results.stale++;
     continue;
    }
    try{
     const response=await transport.send({companyId:co,messageId:job.messageId,channel:job.channel,body,idempotencyKey:'inbox:'+co+':'+job.messageId});
     if(!response||typeof response.providerId!=='string'||!response.providerId.trim())throw Error('missing_provider_ack');
     if(await repo.markSent(co,job.id,job.leaseToken,response.providerId))results.sent++;else results.stale++;
    }catch(err){
     const dead=job.attempts>=5,code=err instanceof Error?err.message:'provider_error';
     if(await repo.markRetry(co,job.id,job.leaseToken,retryAfter(job.attempts),code,dead)){
      if(dead)results.dead++;else results.retried++;
     }else results.stale++;
    }
   }
   return results;
  }
 };
}
