/**
 * Read-only activation inspection of all four existing Inbox tables.
 * No production migration, role changes, or feature activation occur here.
 */
import { inspectMarketingPolicies } from '../marketing/policy-inspection.ts';
import type { MarketingSchemaProbe } from '../marketing/schema-readiness.ts';
export const INBOX_TABLES = ['inbox_participants','inbox_threads','inbox_thread_participants','inbox_messages'] as const;
export type InboxSchemaProbe = MarketingSchemaProbe;
export interface InboxReadiness { ready:boolean; issues:string[]; }
export async function verifyInboxSchema(probe:InboxSchemaProbe):Promise<InboxReadiness>{
 if(!probe||typeof probe.query!=='function')throw Error('inbox: database schema probe required');
 const issues:string[]=[];
 const role=(await probe.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",['desk_app'])).rows[0];
 if(!role)issues.push('restricted desk_app role missing');
 else{
  if(role.rolsuper!==false)issues.push('desk_app cannot be superuser');
  if(role.rolbypassrls!==false)issues.push('desk_app cannot bypass RLS');
 }
 const tables=(await probe.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
    CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN has_table_privilege('desk_app',c.oid,'SELECT') ELSE false END AS can_select,
    CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN has_table_privilege('desk_app',c.oid,'INSERT') ELSE false END AS can_insert,
    CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN has_table_privilege('desk_app',c.oid,'UPDATE') ELSE false END AS can_update
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`,[INBOX_TABLES])).rows;
 for(const name of INBOX_TABLES){
  const t=tables.find(row=>row.relname===name);
  if(!t){issues.push(name+' missing');continue;}
  if(t.relrowsecurity!==true||t.relforcerowsecurity!==true)issues.push(name+' must ENABLE and FORCE RLS');
  if(role&&(t.can_select!==true||t.can_insert!==true||t.can_update!==true))issues.push(name+' missing desk_app CRUD privileges');
 }
 const policies=(await probe.query(`SELECT tablename,policyname,roles,cmd,permissive,qual,with_check
    FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[])`,[INBOX_TABLES])).rows;
 for(const table of INBOX_TABLES)issues.push(...inspectMarketingPolicies(table,policies));
 return{ready:issues.length===0,issues};
}
export async function requireInboxSchema(probe:InboxSchemaProbe):Promise<void>{
 const result=await verifyInboxSchema(probe);
 if(!result.ready)throw Error('inbox: database security not ready: '+result.issues.join('; '));
}
