/**
 * Generic first-party HMAC contract for callback gateways controlled by Titan.
 * Not compatible with arbitrary provider signature formats without an adapter.
 * Callers MUST supply the original bytes, not re-stringified JSON.
 */
import {createHmac,timingSafeEqual} from 'node:crypto';
export class InvalidProviderSignature extends Error {
 constructor(message='invalid_provider_signature'){super(message);this.name='InvalidProviderSignature';}
}
export function verifyProviderSignature(input:{
 rawBody:Buffer;timestamp:unknown;signature:unknown;secret:unknown;
 now?:number;maxAgeSeconds?:number;
}):void{
 if(!Buffer.isBuffer(input.rawBody)||input.rawBody.length===0||input.rawBody.length>65536)
  throw new InvalidProviderSignature('invalid_payload_size');
 if(typeof input.secret!=='string'||input.secret.length<32)
  throw new InvalidProviderSignature('missing_provider_secret');
 if(typeof input.timestamp!=='string'||!/^\d{10}$/.test(input.timestamp))
  throw new InvalidProviderSignature('invalid_timestamp');
 const seconds=Number(input.timestamp),now=input.now??Date.now(),window=input.maxAgeSeconds??300;
 if(!Number.isFinite(now)||!Number.isInteger(window)||window<1||window>600||
    Math.abs(Math.floor(now/1000)-seconds)>window)
  throw new InvalidProviderSignature('expired_timestamp');
 if(typeof input.signature!=='string'||!/^sha256=[a-f0-9]{64}$/i.test(input.signature))
  throw new InvalidProviderSignature('invalid_signature_format');
 const expected=createHmac('sha256',input.secret).update(input.timestamp).update('.').update(input.rawBody).digest();
 const received=Buffer.from(input.signature.slice(7),'hex');
 if(received.length!==expected.length||!timingSafeEqual(received,expected))
  throw new InvalidProviderSignature();
}
