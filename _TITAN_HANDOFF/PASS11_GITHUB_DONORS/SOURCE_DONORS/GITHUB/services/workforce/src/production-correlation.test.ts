import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStorage } from '../../../packages/storage/src/index.js';
import { createProductionRuntimeBootstrap } from './production-runtime-bootstrap.js';

test('production dispatch persists interaction correlation on the linked run', async () => {
 const storage=createSqliteStorage(':memory:');
 try {
 const ports={modelRouter:{next:async()=>({final:'inspected'})},capabilities:{resolve:async()=>null},contextProvider:{load:async()=>({})},authorityGateway:{authorize:async()=>({status:'denied'}),execute:async()=>{throw Error('unexpected');}}};
 const bootstrap=await createProductionRuntimeBootstrap({storage,ports});
 await bootstrap.workforce.registerWorker({company_id:'a',worker_id:'manager',kind:'digital',active:true,capabilities:['work.delegate']});
 await bootstrap.dispatch({company_id:'a',actor_id:'owner',conversation_id:'conversation',interaction_id:'interaction',client_message_id:'message',correlation_id:'correlation',text:'Inspect'});
 const run=await bootstrap.runStore.findByWork('a','zero:conversation:message');
 assert.equal(run.interaction_id,'interaction');
 assert.equal(run.correlation_id,'correlation');
 } finally {await storage.close();}
});
