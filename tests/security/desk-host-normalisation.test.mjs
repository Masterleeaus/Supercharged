import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseHost, buildModeConfig, resolveDeskMode } from '../../server/modules/desk-modes/mode-resolver.ts';
const config=buildModeConfig({workforceHosts:'superchargedat.work',commsHosts:'syncedat.work'});
test('only valid host and port combinations select a mode',()=>{
  for(const h of ['syncedat.work','SYNCEDAT.WORK:443','syncedat.work.:65535']) assert.equal(resolveDeskMode(h,config).mode,'comms');
  for(const h of ['syncedat.work:0','syncedat.work:65536','syncedat.work:99999','syncedat.work:abc','syncedat.work:123456']) assert.notEqual(resolveDeskMode(h,config).ok,true,h);
});
test('host spoofing by prefix, suffix or user information is refused',()=>{
  for(const h of ['evilsyncedat.work','syncedat.work.evil.test','admin@syncedat.work','https://syncedat.work','syncedat.work/path']) {
    assert.equal(resolveDeskMode(h,config).ok,false,h);
  }
  assert.equal(normaliseHost(undefined),null);
});
