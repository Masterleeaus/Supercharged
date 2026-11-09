import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMarketingSchema} from '../../server/modules/marketing/schema-readiness.ts';
const table=name=>({relname:name,relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_update:true});
const base=()=>({async query(sql){if(sql.startsWith('SELECT rolname'))return{rows:[{rolsuper:false,rolbypassrls:false}]};if(sql.includes('FROM pg_class c JOIN'))return{rows:['landing_pages','content_items'].map(table)};if(sql.includes('FROM pg_policies'))return{rows:[]};throw Error(sql);}});
test('a missing tenant policy prevents deployment',async()=>{const r=await verifyMarketingSchema(base());assert.equal(r.ready,false);assert.equal(r.issues.filter(x=>x.includes('tenant policy missing')).length,2);});
test('RLS enabled without FORCE is not accepted',async()=>{
 const p=base(),original=p.query;p.query=async sql=>sql.includes('FROM pg_class c JOIN')?{rows:['landing_pages','content_items'].map(t=>({...table(t),relforcerowsecurity:false}))}:original(sql);
 const r=await verifyMarketingSchema(p);assert.equal(r.issues.filter(x=>x.includes('FORCE')).length,2);
});
test('missing restricted-role update rights prevent deployment',async()=>{
 const p=base(),original=p.query;p.query=async sql=>sql.includes('FROM pg_class c JOIN')?{rows:['landing_pages','content_items'].map(t=>({...table(t),can_update:false}))}:original(sql);
 const r=await verifyMarketingSchema(p);assert.ok(r.issues.some(x=>x.includes('permissions')));
});

test('query for policy metadata includes permissive flag so OR policies are auditable',async()=>{
 const statements=[];const p=base(),original=p.query;
 p.query=async sql=>{statements.push(sql);return original(sql);};
 await verifyMarketingSchema(p);
 assert.ok(statements.some(sql=>sql.includes('SELECT tablename,policyname,roles,cmd,permissive,qual,with_check')));
});
