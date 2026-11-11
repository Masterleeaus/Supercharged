/** Review-only SQL candidate inventory. Never applies migrations. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const STATE_CANDIDATE=fileURLToPath(new URL('../migrations/candidates/0021_inbox_delivery_state.sql',import.meta.url));
export function inspectDeliveryCandidate(sql){
 const required=['CREATE TABLE IF NOT EXISTS public.inbox_delivery_state',
  'PRIMARY KEY(company_id,outbox_id)',
  'FOREIGN KEY(company_id,outbox_id)',
  'REFERENCES public.inbox_outbox(company_id,id)',
  'ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY',
  'CREATE POLICY inbox_delivery_state_tenant_boundary','FOR ALL TO desk_app',
  "current_setting('app.company_id',true)",'WITH CHECK','GRANT SELECT, INSERT, UPDATE'];
 const problems=required.filter(v=>!sql.includes(v)).map(v=>'missing '+v);
 if(/GRANT[^;]+ TO PUBLIC/i.test(sql))problems.push('PUBLIC role grant');
 return problems;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const issues=inspectDeliveryCandidate(readFileSync(STATE_CANDIDATE,'utf8'));
 if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}
 else console.log('Inbox delivery-state candidate preflight passed, no migrations applied.');
}
