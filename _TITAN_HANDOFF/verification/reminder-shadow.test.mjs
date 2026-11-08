import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REMINDER_SHADOW_SQL, SHADOW_REMINDER_MAX_BATCH, ReminderShadowError,
  planQueuedVisitReminder, runQueuedVisitReminderShadow
} from '../field/apps/web/lib/titan/desk-bridge/reminder-shadow.mjs';
import { submitDeskCommunicationIntent } from '../field/apps/web/lib/titan/desk-bridge/client.mjs';
import { receiveCommunicationIntent } from '../desk/server/integrations/titan-field/receiver.mjs';

const HOME = dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();
const SECRET = 'shadow-reminder-dev-only-secret-not-for-production-12345';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const VISIT = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const QUEUE = '66666666-6666-4666-8666-666666666666';
const at = (n) => new Date(n).toISOString();
const row = (overrides = {}) => ({
  queue_id: QUEUE, account_id:COMPANY, client_id:CLIENT, visit_id:VISIT,
  job_id: JOB, visit_status:'scheduled', scheduled_start:at(NOW+6*3600_000),
  client_phone:'+61400111222',sms_consent:true,
  sms_consent_at:at(NOW-8*3600_000),sms_consent_source:'portal', ...overrides
});
function deps(rows=[row()]) {
  const calls=[];
  return {
    calls,
    queryRows:async(sql,params)=>{calls.push({sql,params});return rows;},
  };
}
function fakeDeskPorts() {
  const claimed = new Map();const receipts=[];let sends=0;
  return {claimed,receipts,get sends(){return sends},ports:{
    async resolveCompany(companyId) {
      return companyId===COMPANY?{company_id:COMPANY,desk_user_id:'desk-123',active:true}:null;
    },
    async verifyConsent(){return true;},
    async claimEvent({companyId,eventId,payloadHash}) {
      const k=companyId+':'+eventId;
      const existing=claimed.get(k);
      if(existing)return {state:'duplicate',payloadHash:existing.payloadHash,receipt:existing.receipt};
      claimed.set(k,{payloadHash,receipt:null});return {state:'claimed'};
    },
    async recordResult({receipt}) {
      receipts.push(receipt);
      const k=receipt.company_id+':'+receipt.source_event_id;
      claimed.set(k,{...claimed.get(k),receipt});
    },
    async send(){sends++},
  }};
}

test('source-derived SQL scopes the real Field queue, visits, job and client by account', () => {
  for (const expected of ["nq.account_id = $1", "nq.automation_type = 'visit_reminder'",
      "nq.status = 'pending'", "nq.entity_type = 'visit'", 'nq.next_attempt_at <= now()',
      'v.account_id = nq.account_id', 'j.account_id = nq.account_id',
      'c.account_id = nq.account_id', 'c.id = j.client_id'])
    assert.ok(REMINDER_SHADOW_SQL.includes(expected), expected);
  assert.equal(/INSERT|UPDATE|DELETE/i.test(REMINDER_SHADOW_SQL),false);
  const route=readFileSync(join(HOME,'../field/apps/web/app/api/v1/titan/desk-bridge/reminders/route.ts'),'utf8');
  assert.match(route,/withRole\(\['owner', 'admin'\]/);
  assert.match(route,/TITAN_FIELD_DESK_SHADOW_MODE/);
  assert.match(route,/dryRun: parsed\.data\.dry_run !== false/);
});

test('plans stable, PII-free, SMS shadow intent for pending visit reminder', () => {
  const r=row();
  const a=planQueuedVisitReminder(r,{companyId:COMPANY,now:NOW});
  const b=planQueuedVisitReminder(r,{companyId:COMPANY,now:NOW+30_000});
  assert.deepEqual(a,b); // identical signed bytes on retry
  assert.equal(a.channel,'sms');
  assert.equal(a.template_key,'job_reminder');
  assert.equal(a.resource.kind,'visit');
  assert.equal(a.resource.reference,VISIT);
  assert.equal(a.company_id,COMPANY);
  assert.equal(a.requested_at,at(Date.parse(r.scheduled_start)-24*3600_000));
  assert.equal(JSON.stringify(a).includes(r.client_phone),false);
  assert.equal(a.message,undefined);
});

test('event identity changes with reschedule or source queue item', () => {
  const base=planQueuedVisitReminder(row(),{companyId:COMPANY,now:NOW});
  const moved=planQueuedVisitReminder(row({scheduled_start:at(NOW+7*3600_000)}),{companyId:COMPANY,now:NOW});
  const newQueue=planQueuedVisitReminder(row({queue_id:randomUUID()}),{companyId:COMPANY,now:NOW});
  assert.notEqual(base.event_id,moved.event_id);
  assert.notEqual(base.event_id,newQueue.event_id);
});

test('cross-company row rejected even if SQL port returns it', () => {
  assert.throws(()=>planQueuedVisitReminder(row({account_id:OTHER}),{companyId:COMPANY,now:NOW}),/company_mismatch/);
});

test('cancelled, completed and active visits are not modeled as reminders', () => {
  for(const status of ['cancelled','completed','in_progress'])
    assert.throws(()=>planQueuedVisitReminder(row({visit_status:status}),{companyId:COMPANY,now:NOW}),/visit_not_scheduled/);
});

test('rejects past visits and visits outside 24h reminder window', () => {
  for(const scheduled_start of [at(NOW-1000),at(NOW+25*3600_000)])
    assert.throws(()=>planQueuedVisitReminder(row({scheduled_start}),{companyId:COMPANY,now:NOW}),/outside_reminder_window/);
});

test('explicit SMS opt-in required; revocation and opt-out sources reject', () => {
  for(const override of [{sms_consent:false}, {sms_consent:null},
    {sms_consent_source:'portal_opt_out'}, {sms_consent_source:'sms_stop'}])
    assert.throws(()=>planQueuedVisitReminder(row(override),{companyId:COMPANY,now:NOW}),/sms_consent_missing_or_revoked/);
});

test('rejects missing phone or missing/future consent evidence', () => {
  assert.throws(()=>planQueuedVisitReminder(row({client_phone:null}),{companyId:COMPANY,now:NOW}),/sms_recipient_missing/);
  for(const sms_consent_at of [null, 'invalid-date', at(NOW+60_000)])
    assert.throws(()=>planQueuedVisitReminder(row({sms_consent_at}),{companyId:COMPANY,now:NOW}),/sms_consent_evidence_invalid/);
});

test('rejects malformed source IDs rather than inventing recipients', () => {
  for(const name of ['queue_id','client_id','visit_id','job_id'])
    assert.throws(()=>planQueuedVisitReminder(row({[name]:'?' }),{companyId:COMPANY,now:NOW}),/invalid_/);
});

test('read-only dry run lists eligibility without calling Desk', async()=>{
  const source=deps([row(), row({queue_id:randomUUID(),sms_consent:false})]);
  let submitted=0;
  const result=await runQueuedVisitReminderShadow({companyId:COMPANY, now:NOW,
    queryRows:source.queryRows,submitIntent:async()=>{submitted++}});
  assert.equal(result.mode,'preview');
  assert.equal(result.eligible,1);
  assert.equal(result.skipped,1);
  assert.equal(result.simulated,0);
  assert.equal(submitted,0);
  assert.deepEqual(source.calls[0].params,[COMPANY,5]);
  assert.equal(JSON.stringify(result).includes('+614'),false);
});

test('no Desk submit port means non-preview fails closed', async()=>{
  await assert.rejects(()=>runQueuedVisitReminderShadow({companyId:COMPANY,queryRows:deps().queryRows,dryRun:false}),/submit_port_missing/);
});

test('invalid request limits rejected; no query executed', async()=>{
  let queries=0;
  for(const limit of [-1,0,11,1.5,'5',Number.NaN])
    await assert.rejects(()=>runQueuedVisitReminderShadow({companyId:COMPANY,limit,queryRows:async()=>{queries++}}),/invalid_batch_limit/);
  assert.equal(queries,0);
  assert.equal(SHADOW_REMINDER_MAX_BATCH,10);
});

test('malicious query returns too many rows; fail closed', async()=>{
  const result=runQueuedVisitReminderShadow({companyId:COMPANY,limit:1,queryRows:async()=>[row(),row()]});
  await assert.rejects(result,/queue_query_invalid/);
});

test('duplicate queue row in one batch is projected at most once', async()=>{
  const source=deps([row(),row()]);let submissions=0;
  const result=await runQueuedVisitReminderShadow({companyId:COMPANY,now:NOW,
    dryRun:false,queryRows:source.queryRows,submitIntent:async intent=>{
      submissions++;return {status:'simulated',delivery_status:'not_sent',source_event_id:intent.event_id,
        company_id:intent.company_id,correlation_id:intent.correlation_id};
    }});
  assert.equal(result.eligible,1);
  assert.equal(result.skipped,1);
  assert.equal(result.simulated,1);
  assert.equal(submissions,1);
});

test('untruthful delivered receipt rejected; no success', async()=>{
  const result=await runQueuedVisitReminderShadow({companyId:COMPANY,now:NOW,dryRun:false,
    queryRows:deps().queryRows,submitIntent:async intent=>({source_event_id:intent.event_id,
      company_id:COMPANY,correlation_id:intent.correlation_id,status:'simulated',delivery_status:'delivered'})});
  assert.equal(result.failed,1);
  assert.equal(result.simulated,0);
  assert.equal(result.events[0].state,'shadow_unavailable');
});

test('partial transport outage does not abort unrelated reminders', async()=>{
  const source=deps([row(),row({queue_id:randomUUID(),visit_id:randomUUID()})]);let n=0;
  const result=await runQueuedVisitReminderShadow({companyId:COMPANY,now:NOW,dryRun:false,
    queryRows:source.queryRows,submitIntent:async intent=>{
      if(++n===1)throw Error('transport down');
      return {source_event_id:intent.event_id,correlation_id:intent.correlation_id,
        company_id:COMPANY,status:'simulated',delivery_status:'not_sent'};
    }});
  assert.equal(result.failed,1);assert.equal(result.simulated,1);
});

test('real local HTTP round-trip from pending Field visit queue to Desk fake ledger',async()=>{
  const desk=fakeDeskPorts();
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const response=await receiveCommunicationIntent({body:Buffer.concat(chunks),headers:req.headers},{
      ports:desk.ports,secret:SECRET,now:Date.now()});
    res.writeHead(response.status,{'content-type':'application/json'});
    res.end(JSON.stringify(response.body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    const endpoint=`http://127.0.0.1:${port}/api/titan-bridge/v1/communication-intents`;
    const submitIntent=intent=>submitDeskCommunicationIntent(intent,{endpoint,secret:SECRET});
    const input={companyId:COMPANY,now:NOW,queryRows:deps().queryRows,submitIntent,dryRun:false};
    const first=await runQueuedVisitReminderShadow(input);
    const second=await runQueuedVisitReminderShadow(input);
    assert.equal(first.simulated,1);assert.equal(second.duplicates,1);
    assert.equal(desk.receipts.length,1);
    assert.equal(desk.sends,0);
    assert.equal(first.events[0].delivery_status,'not_sent');
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('Desk can revoke consent after Field plans but before shadow claim', async()=>{
  const intent=planQueuedVisitReminder(row(),{companyId:COMPANY,now:NOW});
  const desk=fakeDeskPorts();
  desk.ports.verifyConsent=async()=>false;
  let claimed=0;
  desk.ports.claimEvent=async()=>{claimed++;return {state:'claimed'}};
  const secret=SECRET;
  const payload=Buffer.from(JSON.stringify(intent));
  const {signBridgeRequest}=await import('../field/apps/web/lib/titan/desk-bridge/protocol.mjs');
  const ts=Math.floor(Date.now()/1000);
  const result=await receiveCommunicationIntent({body:payload,headers:{
    'x-titan-bridge-timestamp':String(ts),
    'x-titan-bridge-signature':signBridgeRequest({rawBody:payload,secret,timestamp:ts})
  }},{ports:desk.ports,secret,now:Date.now()});
  assert.equal(result.status,403);
  assert.equal(claimed,0);
  assert.equal(desk.receipts.length,0);
});

test('Field query failure does not invoke Desk or emit false results', async()=>{
  let submitted=0;
  await assert.rejects(()=>runQueuedVisitReminderShadow({
    companyId:COMPANY,dryRun:false,
    queryRows:async()=>{throw new Error('field-db-unavailable')},
    submitIntent:async()=>{submitted++}
  }),/field-db-unavailable/);
  assert.equal(submitted,0);
});
