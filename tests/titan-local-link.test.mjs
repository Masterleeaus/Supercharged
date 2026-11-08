import test from 'node:test';
import assert from 'node:assert/strict';
import {signLocalLinkRequest,verifyLocalLinkRequest,signLocalLinkResponse,verifyLocalLinkResponse,
 FIELD_CAPABILITY_PATH} from '../server/integrations/titan-field/local-link-wire.mjs';
import {localBridgeUrl,localPeerUrl} from '../server/integrations/titan-field/local-link-topology.mjs';
import {describeDeskLocalCapabilities} from '../server/integrations/titan-field/local-link-capabilities.mjs';
const secret='DESK-LOCAL-LINK-TEST-KEY-LENGTH-32-PLUS';
const now=Date.parse('2026-11-02T00:00:00Z');
test('Desk resolves local Field on loopback only',()=>{
 assert.equal(localPeerUrl('titan-field').port,'3000');
 assert.equal(localBridgeUrl('desk_to_field_proposal').pathname,'/api/v1/titan/desk-bridge/reply-proposals');
 assert.throws(()=>localPeerUrl('titan-field',{origin:'http://localhost:3000'}));
});
test('Desk signs and checks private Field capability request',()=>{
 const timestamp=String(now/1000),signature=signLocalLinkRequest({secret,path:FIELD_CAPABILITY_PATH,timestamp});
 assert.equal(verifyLocalLinkRequest({secret,path:FIELD_CAPABILITY_PATH,timestamp,signature,now}),true);
 assert.throws(()=>verifyLocalLinkRequest({secret,path:FIELD_CAPABILITY_PATH,timestamp,signature:'x',now}));
});
test('Desk capability result is nonexecuting and receipt authenticates',()=>{
 const manifest=describeDeskLocalCapabilities({TITAN_FIELD_BRIDGE_MODE:'shadow'});
 assert.equal(manifest.execution,'disabled');
 const timestamp=String(now/1000),body=JSON.stringify(manifest);
 const signature=signLocalLinkResponse({secret,path:FIELD_CAPABILITY_PATH,timestamp,body});
 assert.equal(verifyLocalLinkResponse({secret,path:FIELD_CAPABILITY_PATH,timestamp,body,signature}).service,'titan-desk');
});
