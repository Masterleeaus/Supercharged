import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxRouterForProduction } from '../../server/modules/inbox/production-router.ts';
import { createMarketingRouterForProduction } from '../../server/modules/marketing/production-router.ts';
import { INBOX_OPERATIONS, MARKETING_OPERATIONS } from '../../server/modules/desk-modes/service-contracts.ts';
const complete = (ops) => Object.fromEntries(ops.map(name => [name, async () => []]));
const role=()=>(_req,_res,next)=>next();
test('inbox factory refuses missing dependencies',()=>{
 for(const deps of [undefined,{}, {service:{}}, {requireRole:role}]) assert.throws(()=>createInboxRouterForProduction(deps),/required/);
});
test('marketing factory refuses missing dependencies',()=>{
 for(const deps of [undefined,{}, {service:{}}, {requireRole:role}]) assert.throws(()=>createMarketingRouterForProduction(deps),/required/);
});
test('a production adapter preserves route factories without manufacturing stores',()=>{
 const inbox=createInboxRouterForProduction({service:complete(INBOX_OPERATIONS),requireRole:role});
 const marketing=createMarketingRouterForProduction({service:complete(MARKETING_OPERATIONS),requireRole:role});
 assert.equal(typeof inbox,'function');
 assert.equal(typeof marketing,'function');
 assert.ok(inbox.stack.length>=8);
 assert.ok(marketing.stack.length>=10);
});

test('factories refuse a service with one missing operation',()=>{
 const inbox=complete(INBOX_OPERATIONS);delete inbox.listThreads;
 const marketing=complete(MARKETING_OPERATIONS);delete marketing.publishPage;
 assert.throws(()=>createInboxRouterForProduction({service:inbox,requireRole:role}),/listThreads/);
 assert.throws(()=>createMarketingRouterForProduction({service:marketing,requireRole:role}),/publishPage/);
});
