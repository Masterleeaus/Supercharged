import test from 'node:test';
import assert from 'node:assert/strict';
import {makeShadowActivitySummary} from '../field/apps/web/lib/titan/desk-bridge/response-projection.mjs';
const example=()=>({mode:'preview',scanned:1,eligible:1,skipped:0,simulated:0,duplicates:0,failed:0,
 events:[{event_id:'a'.repeat(32),state:'eligible',delivery_status:'not_sent',phone:'+61400000000',token:'SECRET'}]});
test('activity projection removes unexpected customer fields',()=>{
 const r=makeShadowActivitySummary('booking_confirmation',example());
 assert.equal(r.schema,'titan.field-desk.shadow-activity.v1');assert.ok(!JSON.stringify(r).includes('SECRET'));
 assert.ok(!JSON.stringify(r).includes('+614'));assert.equal(r.delivery_status,'not_sent');
});
test('activity projection rejects falsely delivered events',()=>assert.throws(()=>makeShadowActivitySummary('booking_confirmation',
 {...example(),events:[{state:'simulated',delivery_status:'delivered'}]}),/invalid_projection_event/));
test('activity projection rejects inconsistent counters',()=>assert.throws(()=>makeShadowActivitySummary('booking_confirmation',
 {...example(),eligible:0}),/invalid_projection_counts/));
test('activity projection rejects weird workflow names',()=>assert.throws(()=>makeShadowActivitySummary('../secret',example()),/invalid_projection/));
test('activity projection never includes unexpected event id',()=>{
 const r=makeShadowActivitySummary('booking_confirmation',{...example(),events:[{event_id:'not-hash',state:'eligible'}]});
 assert.equal(r.events[0].event_id,undefined);
});
