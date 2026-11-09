import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMarketingSchema,requireMarketingSchema} from '../../server/modules/marketing/schema-readiness.ts';
export function probe(overrides={}) {
 const tables=['landing_pages','content_items'];
 const role={rolname:'desk_app',rolsuper:false,rolbypassrls:false};
 const tab=table=>({relname:table,relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_update:true});
 const policy=table=>({tablename:table,policyname:table+'_tenant_boundary',roles:['desk_app'],cmd:'ALL',qual:"company_id = nullif(current_setting('app.company_id', true), '')::uuid",with_check:"company_id = nullif(current_setting('app.company_id', true), '')::uuid"});
 return {async query(sql){if(sql.includes('FROM pg_roles')) return {rows:overrides.roles??[role]};if(sql.includes('FROM pg_class')) return {rows:overrides.tables??tables.map(tab)};if(sql.includes('FROM pg_policies'))return {rows:overrides.policies??tables.map(policy)};throw Error('unexpected query');}};
}
test('a complete, restricted RLS schema passes',async()=>{assert.deepEqual(await verifyMarketingSchema(probe()),{ready:true,issues:[]});await requireMarketingSchema(probe());});
test('missing role fails closed',async()=>{const r=await verifyMarketingSchema(probe({roles:[]}));assert.equal(r.ready,false);assert.ok(r.issues.some(x=>x.includes('desk_app')));});
test('a bypass-RLS role fails even if tables are forced',async()=>{const r=await verifyMarketingSchema(probe({roles:[{rolname:'desk_app',rolsuper:false,rolbypassrls:true}]}));assert.ok(r.issues.some(x=>x.includes('bypass')));});
test('a superuser role fails',async()=>{const r=await verifyMarketingSchema(probe({roles:[{rolname:'desk_app',rolsuper:true,rolbypassrls:false}]}));assert.ok(r.issues.some(x=>x.includes('superuser')));});
test('missing tables are reported',async()=>{const r=await verifyMarketingSchema(probe({tables:[]}));assert.ok(r.issues.some(x=>x.includes('landing_pages missing')));});

test('PostgreSQL name[] literal returned by pg identifies the restricted role',async()=>{
 const original=probe();const query=original.query.bind(original);
 const schema={async query(sql){const result=await query(sql);if(sql.includes('FROM pg_policies'))return{rows:result.rows.map(p=>({...p,roles:'{desk_app}'}))};return result;}};
 assert.deepEqual(await verifyMarketingSchema(schema),{ready:true,issues:[]});
});
test('PostgreSQL role literals do not accept lookalike roles',async()=>{
 const original=probe();const query=original.query.bind(original);
 const schema={async query(sql){const result=await query(sql);if(sql.includes('FROM pg_policies'))return{rows:result.rows.map(p=>({...p,roles:'{desk_app_admin}'}))};return result;}};
 const result=await verifyMarketingSchema(schema);assert.equal(result.ready,false);
});
