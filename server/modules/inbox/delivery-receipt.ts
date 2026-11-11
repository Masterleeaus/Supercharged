/** Validated delivery facts, independent of provider webhooks and Inbox thread state. */
import {createHash} from 'node:crypto';
import {assertCompanyId} from '../../infrastructure/database/tenant-context.ts';
export type ReceiptOutcome='delivered'|'failed';
export interface DeliveryReceipt {
 companyId:string;provider:string;eventId:string;providerId:string;
 outcome:ReceiptOutcome;payloadSha256:string;providerEventAt:Date|null;
}
const slug=/^[a-z][a-z0-9_-]{0,31}$/;
export function parseDeliveryReceipt(companyId:string,provider:string,rawBody:Buffer):DeliveryReceipt {
 const co=assertCompanyId(companyId);
 if(!slug.test(provider))throw Error('receipt: invalid provider');
 if(!Buffer.isBuffer(rawBody)||rawBody.length<2||rawBody.length>65536)throw Error('receipt: invalid payload');
 let payload:unknown;
 try{payload=JSON.parse(rawBody.toString('utf8'));}catch{throw Error('receipt: malformed JSON');}
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('receipt: object required');
 const p=payload as Record<string,unknown>;
 if(typeof p.eventId!=='string'||!p.eventId.trim()||p.eventId.length>200)throw Error('receipt: invalid eventId');
 if(typeof p.providerId!=='string'||!p.providerId.trim()||p.providerId.length>200)throw Error('receipt: invalid providerId');
 if(p.outcome!=='delivered'&&p.outcome!=='failed')throw Error('receipt: unsupported outcome');
 let providerEventAt:Date|null=null;
 if(p.occurredAt!==undefined){
  if(typeof p.occurredAt!=='string'||p.occurredAt.length>40)throw Error('receipt: invalid occurredAt');
  providerEventAt=new Date(p.occurredAt);
  if(!Number.isFinite(providerEventAt.getTime()))throw Error('receipt: invalid occurredAt');
 }
 return{companyId:co,provider,eventId:p.eventId,providerId:p.providerId,outcome:p.outcome,
  payloadSha256:createHash('sha256').update(rawBody).digest('hex'),providerEventAt};
}
