/**
 * Query-only, tenant-scoped delivery projection; never infer delivery from queued
 * Inbox status or even the outbox's provider-acknowledged 'sent' state.
 */
import {assertCompanyId,withTenant,type TenantPool} from '../../infrastructure/database/tenant-context.ts';
import {mapDeliveryState,type DeliveryState} from './delivery-state.ts';
export interface DeliveryStateReader {
 getByMessage(companyId:string,messageId:string):Promise<DeliveryState|null>;
 listRecent(companyId:string,limit?:number):Promise<DeliveryState[]>;
}
export function createSqlDeliveryStateReader(pool:TenantPool):DeliveryStateReader {
 if(!pool||typeof pool.connect!=='function')throw Error('delivery: PostgreSQL pool required');
 return {
  async getByMessage(companyId,messageId){
   const co=assertCompanyId(companyId);
   if(typeof messageId!=='string'||!messageId.trim()||messageId.length>200)throw Error('delivery: invalid messageId');
   return withTenant(pool,co,async db=>{
    const rows=(await db.query(`SELECT s.company_id,s.outbox_id,o.message_id,s.outcome,
      s.event_id,s.provider_event_at,s.updated_at
      FROM public.inbox_delivery_state s
      JOIN public.inbox_outbox o ON o.company_id=s.company_id AND o.id=s.outbox_id
      WHERE s.company_id=$1 AND o.message_id=$2`,[co,messageId])).rows;
    return rows[0]?mapDeliveryState(rows[0]):null;
   });
  },
  async listRecent(companyId,limit=50){
   const co=assertCompanyId(companyId);
   if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('delivery: invalid limit');
   return withTenant(pool,co,async db=>(await db.query(`SELECT s.company_id,s.outbox_id,o.message_id,
     s.outcome,s.event_id,s.provider_event_at,s.updated_at
     FROM public.inbox_delivery_state s
     JOIN public.inbox_outbox o ON o.company_id=s.company_id AND o.id=s.outbox_id
     WHERE s.company_id=$1 ORDER BY s.updated_at DESC,s.outbox_id ASC LIMIT $2`,[co,limit])).rows.map(mapDeliveryState));
  }
 };
}
