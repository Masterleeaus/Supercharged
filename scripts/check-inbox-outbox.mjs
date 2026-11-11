/** Static audit of review-only migration, never a production migration invocation. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const OUTBOX_CANDIDATE=fileURLToPath(new URL('../migrations/candidates/0019_inbox_outbox.sql',import.meta.url));
export function validateOutboxCandidate(sql){
 const required=['CREATE TABLE IF NOT EXISTS public.inbox_outbox','UNIQUE(company_id,message_id)',
  'FOREIGN KEY(company_id,message_id)','REFERENCES public.inbox_messages(company_id,id)',
  'ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY',
  'CREATE POLICY inbox_outbox_tenant_boundary','FOR ALL TO desk_app',
  "current_setting('app.company_id',true)",'WITH CHECK','TO desk_app'];
 const errors=required.filter(x=>!sql.includes(x)).map(x=>'outbox candidate missing '+x);
 if(/GRANT [^;]+ TO PUBLIC/i.test(sql))errors.push('outbox candidate grants PUBLIC');
 return errors;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const problems=validateOutboxCandidate(readFileSync(OUTBOX_CANDIDATE,'utf8'));
 if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}
 else console.log('Outbox candidate verified; no production SQL executed.');
}
