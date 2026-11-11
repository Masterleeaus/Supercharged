import test from 'node:test';import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifyProviderSignature,InvalidProviderSignature} from '../../server/modules/inbox/provider-signature.ts';
const secret='a'.repeat(48),rawBody=Buffer.from('{"eventId":"1"}'),now=1762660800000,timestamp=String(Math.floor(now/1000));
const signed=(body=rawBody,ts=timestamp)=>'sha256='+createHmac('sha256',secret).update(ts).update('.').update(body).digest('hex');
test('HMAC over original raw request bytes authenticates',()=>assert.doesNotThrow(()=>verifyProviderSignature({secret,rawBody,timestamp,signature:signed(),now})));
test('changing the original JSON whitespace invalidates HMAC',()=>assert.throws(()=>verifyProviderSignature({secret,rawBody:Buffer.from('{"eventId": "1"}'),timestamp,signature:signed(),now}),InvalidProviderSignature));
test('a stale timestamp is rejected before accepting the signature',()=>assert.throws(()=>verifyProviderSignature({secret,rawBody,timestamp:String(Number(timestamp)-601),signature:signed(rawBody,String(Number(timestamp)-601)),now}),/expired_timestamp/));
test('an incorrect secret or signature cannot authenticate',()=>assert.throws(()=>verifyProviderSignature({secret:'b'.repeat(48),rawBody,timestamp,signature:signed(),now}),InvalidProviderSignature));
test('missing raw bytes and weak signing keys are denied',()=>{
 assert.throws(()=>verifyProviderSignature({secret:'short',rawBody,timestamp,signature:signed(),now}),InvalidProviderSignature);
 assert.throws(()=>verifyProviderSignature({secret,rawBody:Buffer.alloc(0),timestamp,signature:signed(),now}),InvalidProviderSignature);
});
