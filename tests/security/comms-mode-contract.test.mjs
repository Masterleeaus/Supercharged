import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDeskMode, DEFAULT_DESK_MODE_CONFIG } from '../../server/modules/desk-modes/session-mode.ts';
import { verifiedServerMode } from '../../client/src/lib/desk-product-mode.ts';
import { modeAvailability } from '../../client/src/lib/mode-capabilities.ts';
const flags={inbox:true,marketing:true};
test('server and client agree on verified communications response',()=>{
 const server=sessionDeskMode('syncedat.work',DEFAULT_DESK_MODE_CONFIG);
 assert.deepEqual(server,{mode:'comms',source:'host'});
 assert.equal(verifiedServerMode(server),'comms');
 for(const target of ['inbox','marketing']) assert.equal(modeAvailability(target,verifiedServerMode(server),flags).available,true);
});
test('fallback response is never sufficient to authorize client mode',()=>{
 const server=sessionDeskMode('untrusted.test',DEFAULT_DESK_MODE_CONFIG);
 assert.equal(server.source,'default');
 assert.equal(verifiedServerMode(server),null);
 for(const target of ['inbox','marketing']) assert.equal(modeAvailability(target,verifiedServerMode(server),flags).available,false);
});
