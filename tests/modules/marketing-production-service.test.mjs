import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerifiedMarketingService} from '../../server/modules/marketing/production-service.ts';
import {MARKETING_OPERATIONS} from '../../server/modules/desk-modes/service-contracts.ts';
const noop=async()=>true, pool={connect:async()=>{throw Error('no live query should run during construction');}};
const valid={pool,campaigns:{campaignExists:noop},chatbots:{chatbotExists:noop}};
test('production service refuses missing PostgreSQL, campaign and chatbot ports',async()=>{
 await assert.rejects(createVerifiedMarketingService({}),/pool/);
 await assert.rejects(createVerifiedMarketingService({pool}),/campaign/);
 await assert.rejects(createVerifiedMarketingService({pool,campaigns:{campaignExists:noop}}),/chatbot/);
});
test('production service refuses missing schema verification query',async()=>{
 await assert.rejects(createVerifiedMarketingService({...valid}),/schema probe/);
});
test('incomplete database security prevents constructing a live service',async()=>{
 await assert.rejects(createVerifiedMarketingService({...valid,schemaProbe:{query:async()=>({rows:[]})}}),/database security not ready/);
});
test('service never starts from an in-memory pool substitute without connect()',async()=>{
 await assert.rejects(createVerifiedMarketingService({...valid,pool:{},schemaProbe:{query:async()=>({rows:[]})}}),/PostgreSQL pool/);
});
