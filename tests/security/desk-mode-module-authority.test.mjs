import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModeConfig, deskModeMiddleware, requireModule } from '../../server/modules/desk-modes/index.ts';
const config=buildModeConfig({workforceHosts:'superchargedat.work',commsHosts:'syncedat.work'});
function res(){return{statusCode:200,status(c){this.statusCode=c;return this;},json(body){this.body=body;}};}
test('a communications mode can reach only its declared module family',()=>{
  for(const name of ['inbox','campaigns','marketing']){
    const request={headers:{host:'syncedat.work'}};const result=res();let resolved=false;
    deskModeMiddleware(config)(request,result,()=>{resolved=true;});
    assert.equal(resolved,true);
    let allowed=false;requireModule(name)(request,result,()=>{allowed=true;});
    assert.equal(allowed,true);
    let workforce=false;requireModule('workforce-runtime')(request,result,()=>{workforce=true;});
    assert.equal(workforce,false);assert.equal(result.statusCode,404);
  }
});
test('no forged forwarded host opens communications modules on workforce',()=>{
  const request={headers:{host:'superchargedat.work','x-forwarded-host':'syncedat.work'}};
  const result=res();deskModeMiddleware(config)(request,result,()=>{});
  let allowed=false;requireModule('marketing')(request,result,()=>{allowed=true;});
  assert.equal(allowed,false);assert.equal(result.statusCode,404);
});
