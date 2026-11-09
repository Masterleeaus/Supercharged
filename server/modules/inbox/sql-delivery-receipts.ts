/** Durable tenant-scoped event recording; duplicates do not become new facts. */
import {assertCompanyId,withTenant,type TenantPool} from '../../infrastructure/database/tenant-context.ts';
import type {DeliveryReceipt} from './delivery-receipt.ts';
export type ReceiptResult='recorded'|'duplicate'|'unmatched';
export interface ReceiptRepository {record(receipt:DeliveryReceipt):Promise<ReceiptResult>;}
export function createSqlDeliveryReceipts(pool:TenantPool):ReceiptRepository{
 if(!pool||typeof pool.connect!=='function')throw Error('receipt: PostgreSQL pool required');
 return{
  async record(receipt){
   const companyId=assertCompanyId(receipt.companyId);
   if(!/^[a-z][a-z0-9_-]{0,31}$/.test(receipt.provider) ||
     typeof receipt.eventId!=='string'||!receipt.eventId.trim()||receipt.eventId.length>200||
     typeof receipt.providerId!=='string'||!receipt.providerId.trim()||receipt.providerId.length>200||
     !['delivered','failed'].includes(receipt.outcome)||
     !/^[a-f0-9]{64}$/.test(receipt.payloadSha256))throw Error('receipt: invalid evidence');
   return withTenant(pool,companyId,async db=>{
    // Prevent a second event ID from being applied to an unrelated outbox row.
    // An immutable event can only refer to a previously acknowledged outbox send.
    const result=await db.query(`WITH matched AS (
      SELECT id FROM public.inbox_outbox
       WHERE company_id=$1 AND provider_id=$4 AND status='sent'
       ORDER BY updated_at DESC,id ASC LIMIT 1
     ), inserted AS (
      INSERT INTO public.inbox_delivery_receipts(
       company_id,outbox_id,provider,event_id,provider_id,outcome,payload_sha256,provider_event_at)
      SELECT $1,m.id,$2,$3,$4,$5,$6,$7::timestamptz FROM matched m
      ON CONFLICT(company_id,provider,event_id) DO NOTHING
      RETURNING id
     )
     SELECT (SELECT count(*)::integer FROM matched) AS matching,
            (SELECT count(*)::integer FROM inserted) AS inserted`,
     [companyId,receipt.provider,receipt.eventId,receipt.providerId,receipt.outcome,
      receipt.payloadSha256,receipt.providerEventAt]);
    const row=result.rows[0];
    if(Number(row?.matching)===0)return 'unmatched';
    return Number(row?.inserted)===1?'recorded':'duplicate';
   });
  },
 };
}
