import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxRouterForProduction } from '../../server/modules/inbox/production-router.ts';
import { createMarketingRouterForProduction } from '../../server/modules/marketing/production-router.ts';
const role=()=>(_req,_res,next)=>next();
test('inbox factory refuses missing dependencies',()=>{
 for(const deps of [undefined,{}, {service:{}}, {requireRole:role}]) assert.throws(()=>createInboxRouterForProduction(deps),/required/);
});
test('marketing factory refuses missing dependencies',()=>{
 for(const deps of [undefined,{}, {service:{}}, {requireRole:role}]) assert.throws(()=>createMarketingRouterForProduction(deps),/required/);
});
test('a production adapter preserves route factories without manufacturing stores',()=>{
 const inbox=createInboxRouterForProduction({service:{},requireRole:role});
 const marketing=createMarketingRouterForProduction({service:{},requireRole:role});
 assert.equal(typeof inbox,'function');
 assert.equal(typeof marketing,'function');
 assert.ok(inbox.stack.length>=8);
 assert.ok(marketing.stack.length>=10);
});
