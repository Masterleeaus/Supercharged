/** Verifies and consumes Central signed outbox events (contract: Central docs/EVENTS.md, quoted in #196).
 * Scheme in use: header `t=<unix>,v0=<hex HMAC-SHA256>` over `${t}.${rawBody}`, same shape as the
 * repo's existing webhook verifiers. Central's EVENTS.md is not in this repo; confirm before live use.
 * Events are applied in order per tenant and each event id is applied at most once.
 */
import {createHmac,timingSafeEqual} from 'node:crypto';

export const OUTBOX_SECRET_ENV='CENTRAL_OUTBOX_HMAC_SECRET';
export const OUTBOX_TOLERANCE_SECONDS=300;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OutboxRejectCode='no_secret'|'unsigned'|'bad_signature'|'stale_timestamp'|'malformed'|'wrong_product'|'out_of_order';

export class OutboxEventError extends Error{
 readonly code:OutboxRejectCode;
 constructor(code:OutboxRejectCode){super(code);this.name='OutboxEventError';this.code=code}
}

export function readOutboxSecret(env:NodeJS.ProcessEnv=process.env):string{
 const s=env[OUTBOX_SECRET_ENV];
 if(!s||s.length<32)throw new OutboxEventError('no_secret');
 return s;
}

/** Throws OutboxEventError on any failure. Returns the parsed event when valid. */
export function verifyOutboxEvent({rawBody,signatureHeader,secret,nowSeconds}:{
 rawBody:string;signatureHeader:string|undefined;secret:string;nowSeconds:number;
}):{id:string;tenantId:string;seq:number;type:string;payload:unknown}{
 if(!secret||secret.length<32)throw new OutboxEventError('no_secret');
 if(typeof signatureHeader!=='string'||signatureHeader.length===0)throw new OutboxEventError('unsigned');
 let t:string|undefined,v0:string|undefined;
 for(const part of signatureHeader.split(',')){
  const i=part.indexOf('=');if(i<0)continue;
  const k=part.slice(0,i).trim(),val=part.slice(i+1).trim();
  if(k==='t')t=val;else if(k==='v0')v0=val;
 }
 if(!t||!/^\d{1,12}$/.test(t)||!v0||!/^[0-9a-f]{64}$/i.test(v0))throw new OutboxEventError('unsigned');
 if(Math.abs(nowSeconds-Number(t))>OUTBOX_TOLERANCE_SECONDS)throw new OutboxEventError('stale_timestamp');
 const expected=createHmac('sha256',secret).update(`${t}.${rawBody}`,'utf8').digest();
 const got=Buffer.from(v0,'hex');
 if(got.length!==expected.length||!timingSafeEqual(got,expected))throw new OutboxEventError('bad_signature');
 let body:Record<string,unknown>;
 try{body=JSON.parse(rawBody)}catch{throw new OutboxEventError('malformed')}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new OutboxEventError('malformed');
 if(body.product!=='supercharged')throw new OutboxEventError('wrong_product');
 if(typeof body.id!=='string'||body.id.length<1||body.id.length>128)throw new OutboxEventError('malformed');
 if(typeof body.tenant_id!=='string'||!UUID_RE.test(body.tenant_id))throw new OutboxEventError('malformed');
 if(!Number.isSafeInteger(body.seq)||(body.seq as number)<1)throw new OutboxEventError('malformed');
 if(typeof body.type!=='string'||body.type.length<1||body.type.length>128)throw new OutboxEventError('malformed');
 return {id:body.id,tenantId:body.tenant_id,seq:body.seq as number,type:body.type,payload:body.payload};
}

/** Applies each event once, in increasing seq order per tenant. In-memory state: durable store needed for restarts. */
export function createOutboxConsumer({handlers}:{
 handlers:Readonly<Record<string,(event:{id:string;tenantId:string;seq:number;payload:unknown})=>Promise<void>|void>>;
}){
 const lastSeq=new Map<string,number>();
 const applied=new Set<string>();
 return async function consume(event:{id:string;tenantId:string;seq:number;type:string;payload:unknown}):
  Promise<'applied'|'duplicate'|'ignored'>{
  if(applied.has(event.id))return 'duplicate';
  const last=lastSeq.get(event.tenantId)??0;
  if(event.seq<=last)throw new OutboxEventError('out_of_order');
  const h=Object.prototype.hasOwnProperty.call(handlers,event.type)?handlers[event.type]:undefined;
  if(h)await h({id:event.id,tenantId:event.tenantId,seq:event.seq,payload:event.payload});
  applied.add(event.id);
  lastSeq.set(event.tenantId,event.seq);
  return h?'applied':'ignored';
 };
}
