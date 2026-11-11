import test from 'node:test';
import assert from 'node:assert/strict';
import {registerVerifiedCommsRoutes} from '../../server/routes/core/verified-marketing-routes.ts';
const noop=(_req,_res,next)=>next(),role=()=>noop;
const fake={authenticate:noop,requireCompanyScope:noop,requireRole:role};
const app=()=>{const calls=[];return {calls,use:(...args)=>calls.push(args)};};
test('disabled marketing never opens a database or loads a chatbot adapter',async()=>{
 const a=app();const output=await registerVerifiedCommsRoutes(a,{...fake,pool:null,schemaProbe:null,env:{}});
 assert.deepEqual(output.mounted,[]);assert.deepEqual(a.calls,[]);
});
test('enabled marketing fails before mounting when storage or schema is unavailable',async()=>{
 const a=app();
 await assert.rejects(registerVerifiedCommsRoutes(a,{...fake,env:{COMMS_MARKETING_ENABLED:'true'},pool:null,schemaProbe:null}),/PostgreSQL pool/);
 assert.deepEqual(a.calls,[]);
});
test('enabled marketing rejects unverified tenant policy without mounting routes',async()=>{
 const a=app(),pool={connect:async()=>{throw Error('not used')}},schemaProbe={query:async()=>({rows:[]})};
 await assert.rejects(registerVerifiedCommsRoutes(a,{...fake,env:{COMMS_MARKETING_ENABLED:'true'},pool,schemaProbe,chatbots:{findChatbot:async()=>null}}),/database security not ready/);
 assert.deepEqual(a.calls,[]);
});
test('missing guards reject before querying database metadata',async()=>{
 const a=app(),schemaProbe={query:async()=>{throw Error('DB touched')}};
 await assert.rejects(registerVerifiedCommsRoutes(a,{...fake,authenticate:null,env:{COMMS_MARKETING_ENABLED:'true'},pool:{},schemaProbe}),/authentication/);
 assert.deepEqual(a.calls,[]);
});

test('Inbox flag cannot mount without verified schema security',async()=>{
 const a=app(),pool={connect:async()=>{throw Error('not used')}},schemaProbe={query:async()=>({rows:[]})};
 const approvalService={gateAction:async()=>({}),getApproval:async()=>null,recordExecuted:async()=>{}};
 await assert.rejects(registerVerifiedCommsRoutes(a,{...fake,pool,schemaProbe,approvalService,env:{COMMS_INBOX_ENABLED:'true'}}),/database security not ready/);
 assert.deepEqual(a.calls,[]);
});
