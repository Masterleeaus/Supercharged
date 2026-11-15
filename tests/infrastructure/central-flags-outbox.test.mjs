import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createFlagReader} from '../../server/infrastructure/central-sso/feature-flags.ts';
import {verifyOutboxEvent,createOutboxConsumer,OutboxEventError,readOutboxSecret} from '../../server/infrastructure/central-sso/outbox-events.ts';

const secret='s'.repeat(40);
const NOW=1_800_000_000;
const tenantA='00000000-0000-4000-8000-00000000000a';
const tenantB='00000000-0000-4000-8000-00000000000b';
const code=(fn)=>{try{fn();return 'ok'}catch(e){return e instanceof OutboxEventError?e.code:'other:'+e.message}};
const codeAsync=async(fn)=>{try{await fn();return 'ok'}catch(e){return e instanceof OutboxEventError?e.code:'other:'+e.message}};
const sign=(body,t=NOW,key=secret)=>`t=${t},v0=${createHmac('sha256',key).update(`${t}.${body}`).digest('hex')}`;
const ev=(over={})=>JSON.stringify({product:'supercharged',id:'evt-1',tenant_id:tenantA,seq:1,type:'flag.changed',payload:{x:1},...over});

test('flag reads return declared defaults when Central is unreachable or absent', () => {
  const r=createFlagReader({declared:{'quotes.new_flow':false,'jobs.max':5},environment:'prod'});
  assert.equal(r.read('quotes.new_flow'),false);
  assert.equal(r.read('jobs.max'),5);
  const r2=createFlagReader({declared:{'quotes.new_flow':false},environment:'prod',snapshot:()=>{throw new Error('down')}});
  assert.equal(r2.read('quotes.new_flow'),false);
  assert.throws(()=>r2.read('unknown.flag'));
});

test('flag precedence is organisation, rollout, global, then default; wrong product or environment ignored', () => {
  const base={declared:{f:false},environment:'prod'};
  const snap=(over)=>({product:'supercharged',environment:'prod',flags:{f:{global:true,rollout:false,organisation:true}},...over});
  assert.equal(createFlagReader({...base,snapshot:()=>snap()}).read('f'),true);
  assert.equal(createFlagReader({...base,snapshot:()=>snap({flags:{f:{global:true,rollout:false}}})}).read('f'),false);
  assert.equal(createFlagReader({...base,snapshot:()=>snap({flags:{f:{global:true}}})}).read('f'),true);
  assert.equal(createFlagReader({...base,snapshot:()=>snap({product:'desk'})}).read('f'),false);
  assert.equal(createFlagReader({...base,snapshot:()=>snap({environment:'staging'})}).read('f'),false);
});

test('flag snapshot value of the wrong type falls back to the default', () => {
  const r=createFlagReader({declared:{n:3},environment:'prod',snapshot:()=>({product:'supercharged',environment:'prod',flags:{n:{global:'three'}}})});
  assert.equal(r.read('n'),3);
});

test('invalid flag declarations are refused', () => {
  assert.throws(()=>createFlagReader({declared:{},environment:'prod'}));
  assert.throws(()=>createFlagReader({declared:{'Bad Name':true},environment:'prod'}));
  assert.throws(()=>createFlagReader({declared:{a:{}},environment:'prod'}));
});

test('signed event is accepted with the exact signature', () => {
  const body=ev();
  const out=verifyOutboxEvent({rawBody:body,signatureHeader:sign(body),secret,nowSeconds:NOW});
  assert.deepEqual(out,{id:'evt-1',tenantId:tenantA,seq:1,type:'flag.changed',payload:{x:1}});
});

test('unsigned, bad, stale and tampered events are rejected', () => {
  const body=ev();
  assert.equal(code(()=>verifyOutboxEvent({rawBody:body,signatureHeader:undefined,secret,nowSeconds:NOW})),'unsigned');
  assert.equal(code(()=>verifyOutboxEvent({rawBody:body,signatureHeader:'t=abc,v0=00',secret,nowSeconds:NOW})),'unsigned');
  assert.equal(code(()=>verifyOutboxEvent({rawBody:body,signatureHeader:sign(body,NOW,'x'.repeat(40)),secret,nowSeconds:NOW})),'bad_signature');
  assert.equal(code(()=>verifyOutboxEvent({rawBody:body.replace('"x":1','"x":2'),signatureHeader:sign(body),secret,nowSeconds:NOW})),'bad_signature');
  assert.equal(code(()=>verifyOutboxEvent({rawBody:body,signatureHeader:sign(body,NOW-301),secret,nowSeconds:NOW})),'stale_timestamp');
  assert.equal(code(()=>verifyOutboxEvent({rawBody:body,signatureHeader:sign(body,NOW+301),secret,nowSeconds:NOW})),'stale_timestamp');
});

test('events for another product or with bad fields are refused after the signature passes', () => {
  for(const b of [ev({product:'desk'}),ev({tenant_id:'not-a-uuid'}),ev({seq:0}),ev({id:''}),ev({type:''})]){
    assert.equal(code(()=>verifyOutboxEvent({rawBody:b,signatureHeader:sign(b),secret,nowSeconds:NOW})),b.includes('"desk"')?'wrong_product':'malformed');
  }
});

test('secret must be present and at least 32 characters', () => {
  assert.throws(()=>readOutboxSecret({}),OutboxEventError);
  assert.throws(()=>readOutboxSecret({CENTRAL_OUTBOX_HMAC_SECRET:'short'}),OutboxEventError);
  assert.equal(readOutboxSecret({CENTRAL_OUTBOX_HMAC_SECRET:secret}),secret);
});

test('handlers run once per event id and in order per tenant', async () => {
  const seen=[];
  const consume=createOutboxConsumer({handlers:{'flag.changed':(e)=>{seen.push(`${e.tenantId}:${e.seq}`)}}});
  const e=(id,tenantId,seq)=>({id,tenantId,seq,type:'flag.changed',payload:null});
  assert.equal(await consume(e('a',tenantA,1)),'applied');
  assert.equal(await consume(e('a',tenantA,1)),'duplicate');
  assert.equal(await codeAsync(()=>consume(e('b',tenantA,1))),'out_of_order');
  assert.equal(await consume(e('c',tenantB,1)),'applied');
  assert.equal(await consume(e('d',tenantA,2)),'applied');
  assert.deepEqual(seen,[`${tenantA}:1`,`${tenantB}:1`,`${tenantA}:2`]);
});

test('unknown event types are acknowledged without a handler and still advance order', async () => {
  const consume=createOutboxConsumer({handlers:{}});
  assert.equal(await consume({id:'x',tenantId:tenantA,seq:1,type:'other.thing',payload:null}),'ignored');
  assert.equal(await codeAsync(()=>consume({id:'y',tenantId:tenantA,seq:1,type:'other.thing',payload:null})),'out_of_order');
});
