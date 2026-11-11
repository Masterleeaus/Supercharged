/** Company-scoped, conditional PostgreSQL queue operations. No provider is invoked here. */
import {randomUUID} from 'node:crypto';
import {assertCompanyId,withTenant,type TenantPool} from '../../infrastructure/database/tenant-context.ts';
import type {OutboxJob,OutboxRepository} from './outbox-types.ts';
const whole=(n:number,min:number,max:number,label:string)=>{if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('outbox: invalid '+label);return n;};
const row=(r:any):OutboxJob=>({id:r.id,companyId:r.company_id,messageId:r.message_id,channel:r.channel,status:r.status,attempts:r.attempts,nextAttemptAt:new Date(r.next_attempt_at),leasedUntil:r.leased_until?new Date(r.leased_until):null,leaseToken:r.lease_token??null,providerId:r.provider_id??null,lastError:r.last_error??null});
export function createSqlOutbox(pool:TenantPool):OutboxRepository {
 if(!pool||typeof pool.connect!=='function')throw Error('outbox: PostgreSQL pool required');
 return {
  async enqueueQueued(companyId,limit){
   const co=assertCompanyId(companyId),cap=whole(limit,1,500,'limit');
   return withTenant(pool,co,async db=>{
    const q=await db.query(`INSERT INTO public.inbox_outbox(company_id,message_id,channel)
     SELECT m.company_id,m.id,m.channel FROM public.inbox_messages m
      WHERE m.company_id=$1 AND m.direction='outbound' AND m.status='queued'
        AND NOT EXISTS(SELECT 1 FROM public.inbox_outbox o WHERE o.company_id=m.company_id AND o.message_id=m.id)
      ORDER BY m.created_at ASC,m.id ASC LIMIT $2
     ON CONFLICT(company_id,message_id) DO NOTHING RETURNING id`,[co,cap]);
    return q.rows.length;
   });
  },
  async claim(companyId,limit,leaseSeconds){
   const co=assertCompanyId(companyId),cap=whole(limit,1,100,'limit'),ttl=whole(leaseSeconds,5,3600,'leaseSeconds');
   return withTenant(pool,co,async db=>{
    const q=await db.query(`WITH selected AS (
       SELECT o.id FROM public.inbox_outbox o JOIN public.inbox_messages m
        ON m.company_id=o.company_id AND m.id=o.message_id
       WHERE o.company_id=$1 AND m.status='queued' AND m.direction='outbound'
         AND ((o.status IN ('queued','retry') AND o.next_attempt_at<=now())
             OR (o.status='leased' AND o.leased_until<=now()))
       ORDER BY o.next_attempt_at ASC,o.created_at ASC,o.id ASC
       FOR UPDATE OF o SKIP LOCKED LIMIT $2
      )
      UPDATE public.inbox_outbox o SET status='leased',attempts=o.attempts+1,
        lease_token=$3::uuid,leased_until=now()+($4::integer*interval '1 second'),updated_at=now()
      FROM selected s WHERE o.id=s.id AND o.company_id=$1
      RETURNING o.*`,[co,cap,randomUUID(),ttl]);
    return q.rows.map(row);
   });
  },
  async loadBody(companyId,messageId){
   const co=assertCompanyId(companyId);
   return withTenant(pool,co,async db=>{
    const q=await db.query(`SELECT body FROM public.inbox_messages
     WHERE company_id=$1 AND id=$2 AND direction='outbound' AND status='queued'`,[co,messageId]);
    return q.rows[0]?.body??null;
   });
  },
  async markSent(companyId,id,leaseToken,providerId){
   const co=assertCompanyId(companyId);
   if(!providerId||typeof providerId!=='string'||providerId.length>200)throw Error('outbox: invalid providerId');
   return withTenant(pool,co,async db=>(await db.query(`UPDATE public.inbox_outbox
    SET status='sent',provider_id=$4,lease_token=NULL,leased_until=NULL,updated_at=now(),last_error=NULL
    WHERE company_id=$1 AND id=$2::uuid AND lease_token=$3::uuid AND status='leased'
    RETURNING id`,[co,id,leaseToken,providerId])).rows.length===1);
  },
  async markRetry(companyId,id,leaseToken,delaySeconds,errorCode,dead){
   const co=assertCompanyId(companyId),delay=whole(delaySeconds,1,86400,'delaySeconds');
   const reason=typeof errorCode==='string'?errorCode.slice(0,512):'transport_error';
   return withTenant(pool,co,async db=>(await db.query(`UPDATE public.inbox_outbox
    SET status=CASE WHEN $5::boolean THEN 'dead' ELSE 'retry' END,
     next_attempt_at=now()+($4::integer*interval '1 second'),last_error=$6,
     lease_token=NULL,leased_until=NULL,updated_at=now()
    WHERE company_id=$1 AND id=$2::uuid AND lease_token=$3::uuid AND status='leased'
    RETURNING id`,[co,id,leaseToken,delay,dead,reason])).rows.length===1);
  },
 };
}
