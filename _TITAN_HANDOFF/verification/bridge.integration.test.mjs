import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCommunicationIntent, parseCommunicationIntent, signBridgeRequest,
  verifyBridgeRequest, BridgeProtocolError, WIRE_SCHEMA
} from '../field/apps/web/lib/titan/desk-bridge/protocol.mjs';
import { submitDeskCommunicationIntent } from '../field/apps/web/lib/titan/desk-bridge/client.mjs';
import { receiveCommunicationIntent } from '../desk/server/integrations/titan-field/receiver.mjs';

const HOME = dirname(fileURLToPath(import.meta.url));
const FIXED = Date.parse('2026-11-02T00:00:00.000Z');
const SECRET = 'test-shared-secret-32-chars-minimum-for-hmac-6fc1b991';
const URL = 'http://127.0.0.1:3001/api/titan-bridge/v1/communication-intents';
const newIntent = (overrides = {}) => ({
  schema: WIRE_SCHEMA,
  event_id: 'evt-one', correlation_id: 'trace-one', company_id: 'company-A',
  requested_at: new Date(FIXED).toISOString(), channel: 'sms', template_key: 'job_reminder',
  recipient: {kind: 'field_client', reference: 'client-A'},
  resource: {kind: 'job', reference: 'job-01'},
  consent: {evidence_reference: 'consent-A', recorded_at: new Date(FIXED - 3600000).toISOString()},
  ...overrides
});
const sign = (body = newIntent(), {secret = SECRET, timestamp = Math.floor(FIXED / 1000)} = {}) => {
  const raw = Buffer.from(JSON.stringify(body));
  return {body: raw, headers: {
    'x-titan-bridge-timestamp': String(timestamp),
    'x-titan-bridge-signature': signBridgeRequest({rawBody:raw, secret, timestamp})
  }};
};
function ports({ mapping = true, consent = true, ledger = true } = {}) {
  const claims = new Map(); const receipts = [];
  const deps = {
    async resolveCompany(companyId) {
      return mapping ? {company_id: companyId, desk_user_id: 'desk-mapped-user', active: true} : null;
    },
    async verifyConsent() { return consent; },
    async claimEvent({companyId,eventId,payloadHash}) {
      if(!ledger) return {state:'unavailable'};
      const key=`${companyId}:${eventId}`;
      const previous=claims.get(key);
      if(previous) return {state:'duplicate',payloadHash:previous.payloadHash,receipt:previous.receipt};
      claims.set(key,{payloadHash,receipt:null});return {state:'claimed'};
    },
    async recordResult({receipt}) {
      receipts.push(receipt);
      const key=`${receipt.company_id}:${receipt.source_event_id}`;
      const previous=claims.get(key);
      claims.set(key,{...previous,receipt});
    }
  };
  return {deps, claims, receipts};
}
const receive = (request, p, extra={}) => receiveCommunicationIntent(request, {secret:SECRET, now:FIXED, ports:p, ...extra});

test('wire protocol is byte-for-byte identical in both deployment directories', () => {
  const field = readFileSync(join(HOME,'../field/apps/web/lib/titan/desk-bridge/protocol.mjs'));
  const desk = readFileSync(join(HOME,'../desk/server/integrations/titan-field/protocol.mjs'));
  assert.deepEqual(field,desk);
});
test('intents are strictly validated and contain no contact address/message', () => {
  const v=createCommunicationIntent({companyId:'company-A',eventId:'id-1',correlationId:'trace-1',
    channel:'sms',templateKey:'job_reminder',clientReference:'client-A',resourceKind:'job',
    resourceReference:'job-1',consentEvidenceReference:'consent-1',
    consentRecordedAt:new Date().toISOString()});
  assert.equal(v.company_id,'company-A');
  assert.equal(JSON.stringify(v).includes('+614'),false);
  assert.equal(v.message,undefined);
  assert.throws(()=>parseCommunicationIntent(JSON.stringify({...newIntent(),phone:'+61412345678'}),{now:FIXED}),/unexpected_body_field/);
  assert.throws(()=>parseCommunicationIntent(JSON.stringify({...newIntent(),channel:'whatsapp'}),{now:FIXED}),/unsupported_channel/);
  assert.throws(()=>parseCommunicationIntent(JSON.stringify({...newIntent(),company_id:''}),{now:FIXED}),/invalid_company_id/);
  assert.throws(()=>parseCommunicationIntent(JSON.stringify({...newIntent(),requested_at:'2024-01-01T00:00:00Z'}),{now:FIXED}),/stale_event/);
});
test('valid HMAC authorises exactly signed bytes', () => {
  const req=sign();
  assert.equal(verifyBridgeRequest({rawBody:req.body,secret:SECRET,timestamp:req.headers['x-titan-bridge-timestamp'],signature:req.headers['x-titan-bridge-signature'],now:FIXED}),true);
  assert.throws(()=>verifyBridgeRequest({rawBody:Buffer.from(req.body.toString().replace('job-01','job-02')),secret:SECRET,timestamp:req.headers['x-titan-bridge-timestamp'],signature:req.headers['x-titan-bridge-signature'],now:FIXED}),/unauthorized/);
});
test('old HMAC timestamps fail regardless of signature validity', async () => {
  const p=ports(); const req=sign(newIntent(),{timestamp:Math.floor(FIXED/1000)-600});
  const outcome=await receive(req,p.deps);
  assert.equal(outcome.status,401);assert.equal(p.claims.size,0);
});
test('no configured persistence/mapping ports means 503 and no acceptance', async () => {
  const out=await receive(sign(),null);assert.equal(out.status,503);
  assert.equal(out.body.error,'identity_or_ledger_not_configured');
});
test('invalid/mismatched tenant is rejected before event claim', async () => {
  const p=ports({mapping:false});const out=await receive(sign(),p.deps);
  assert.equal(out.status,403);assert.equal(out.body.error,'company_not_authorized');
  assert.equal(p.claims.size,0);
});
test('consent rejection means no claim, no dispatch and no receipt', async () => {
  const p=ports({consent:false});const out=await receive(sign(),p.deps);
  assert.equal(out.status,403);assert.equal(p.claims.size,0);assert.equal(p.receipts.length,0);
});
test('durable ledger failure fails closed', async () => {
  const p=ports({ledger:false});const out=await receive(sign(),p.deps);
  assert.equal(out.status,503);assert.equal(p.receipts.length,0);
});
test('accepted request is simulated only and replay produces no second receipt', async () => {
  const p=ports();const first=await receive(sign(),p.deps);
  assert.equal(first.status,202);assert.equal(first.body.status,'simulated');
  assert.equal(first.body.delivery_status,'not_sent');assert.equal(p.receipts.length,1);
  const second=await receive(sign(),p.deps);
  assert.equal(second.status,200);assert.equal(second.body.status,'duplicate');
  assert.equal(p.receipts.length,1);
});
test('concurrent duplicate requests share one durable ledger event', async () => {
  const p=ports();const [a,b]=await Promise.all([receive(sign(),p.deps),receive(sign(),p.deps)]);
  assert.deepEqual([a.status,b.status].sort(),[202,409]);
  assert.equal(p.receipts.length,1);
});
test('Field-to-Desk transport + Desk receiver produces correlated shadow receipt', async () => {
  const p=ports();const intent=newIntent();let calls=0;
  const fakeFetch=async (url,opts)=>{
    calls++;
    assert.equal(url,URL);assert.equal(opts.redirect,'error');
    const response=await receive({body:Buffer.from(opts.body),headers:opts.headers},p.deps);
    return {ok:response.status>=200 && response.status<300,status:response.status,json:async()=>response.body};
  };
  const receipt=await submitDeskCommunicationIntent(intent,{endpoint:URL,secret:SECRET,
    now:FIXED, fetchImpl:fakeFetch});
  assert.equal(receipt.source_event_id,intent.event_id);assert.equal(receipt.company_id,'company-A');
  assert.equal(receipt.delivery_status,'not_sent');assert.equal(calls,1);
  assert.equal(p.receipts.length,1);
});
test('Field client refuses insecure external HTTP URL without making a call',async()=>{
  let calls=0;
  await assert.rejects(()=>submitDeskCommunicationIntent(newIntent(),{
    endpoint:'http://example.com/api/titan-bridge/v1/communication-intents',
    now:FIXED,secret:SECRET,fetchImpl:async()=>{calls++;return null;}
  }),/desk_bridge_invalid_url/);
  assert.equal(calls,0);
});
test('Field client rejects misleading sent/delivered receipts',async()=>{
  await assert.rejects(()=>submitDeskCommunicationIntent(newIntent(),{
    endpoint:URL,now:FIXED,secret:SECRET,fetchImpl:async()=>({ok:true,status:202,json:async()=>({
      schema:'titan.field-desk.communication-result.v1',source_event_id:'evt-one',company_id:'company-A',
      correlation_id:'trace-one',status:'simulated',delivery_status:'delivered'
    })})
  }),/desk_bridge_invalid_receipt/);
});

test('reusing an event id with a different signed payload is rejected',async()=>{
  const p=ports();
  assert.equal((await receive(sign(),p.deps)).status,202);
  const changed=sign(newIntent({template_key:'job_update'}));
  const result=await receive(changed,p.deps);
  assert.equal(result.status,409);
  assert.equal(p.receipts.length,1);
});

test('a replay pending its durable result cannot claim simulated acceptance', async()=>{
  const p=ports();
  const originalRecord=p.deps.recordResult;
  p.deps.recordResult=async()=>{throw new Error('DB temporarily down')};
  assert.equal((await receive(sign(),p.deps)).status,503);
  p.deps.recordResult=originalRecord;
  const retried=await receive(sign(),p.deps);
  assert.equal(retried.status,409);
  assert.equal(p.receipts.length,0);
});

test('real local HTTP round-trip passes signed bytes and returns no-send receipt', async () => {
  const { createServer } = await import('node:http');
  const p=ports();
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const outcome=await receive({body:Buffer.concat(chunks),headers:req.headers},p.deps);
    res.writeHead(outcome.status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(outcome.body));
  });
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    const receipt=await submitDeskCommunicationIntent(newIntent(),{
      endpoint:`http://127.0.0.1:${port}/api/titan-bridge/v1/communication-intents`,
      secret:SECRET,now:FIXED,fetchImpl:globalThis.fetch
    });
    assert.equal(receipt.status,'simulated');
    assert.equal(receipt.delivery_status,'not_sent');
    assert.equal(p.receipts.length,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
