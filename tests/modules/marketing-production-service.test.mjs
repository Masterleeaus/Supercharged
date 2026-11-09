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

test('production service refuses unsafe policy readiness even if tenant pool exists',async()=>{
 const schemaProbe={async query(sql){
  if(sql.includes('FROM pg_roles'))return{rows:[{rolsuper:false,rolbypassrls:false}]};
  if(sql.includes('FROM pg_class'))return{rows:['landing_pages','content_items'].map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_update:true}))};
  if(sql.includes('FROM pg_policies'))return{rows:[]};throw Error(sql);
 }};
 await assert.rejects(createVerifiedMarketingService({...valid,schemaProbe}),/tenant policy missing/);
});
