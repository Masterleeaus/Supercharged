/** Static candidate audit only; does not connect to PostgreSQL. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const CANDIDATE=fileURLToPath(new URL('../migrations/candidates/0018_inbox_tenant_rls.sql',import.meta.url));
export const INBOX_TABLES=["inbox_participants","inbox_threads","inbox_thread_participants","inbox_messages"];
export function validateInboxRls(sql){
 const issues=[];
 if(!sql.includes('NOT rolsuper AND NOT rolbypassrls'))issues.push('Restricted role guard missing');
 for(const table of INBOX_TABLES){
  for(const line of [`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,`CREATE POLICY ${table}_tenant_boundary ON public.${table}`,`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO desk_app`])if(!sql.includes(line))issues.push(table+': missing '+line);
  const segment=sql.split(`CREATE POLICY ${table}_tenant_boundary`)[1]?.split(';')[0]??'';
  for(const needle of [`FOR ALL TO desk_app`,`USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)`,`WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid)`])if(!segment.includes(needle))issues.push(table+': missing '+needle);
 }
 if(/GRANT [^;]* TO PUBLIC\b/i.test(sql))issues.push('PUBLIC grant forbidden');
 if(/CREATE ROLE|PASSWORD\s+'/i.test(sql))issues.push('Role creation or passwords forbidden');
 return issues;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const result=validateInboxRls(readFileSync(CANDIDATE,'utf8'));
 if(result.length){console.error(result.join('\n'));process.exitCode=1;}
 else console.log('Inbox candidate static preflight passed. No production migration applied.');
}
