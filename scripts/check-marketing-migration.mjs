/** Non-invasive static preflight; never connects to a database or executes SQL. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const CANDIDATE = fileURLToPath(new URL('../migrations/candidates/0017_marketing_tenant_rls.sql',import.meta.url));
export function validateMarketingMigration(sql) {
 const problems=[];
 for(const table of ['landing_pages','content_items']){
  for(const required of [
   `CREATE TABLE IF NOT EXISTS ${table}`,
   `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
   `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
   `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO desk_app`,
   `CREATE POLICY ${table}_tenant_boundary ON ${table}`,
  ]) if(!sql.includes(required)) problems.push(`Missing: ${required}`);
 }
 if ((sql.match(/WITH CHECK \(company_id = nullif\(current_setting\('app.company_id',true\),''\)::uuid\)/g)||[]).length!==2) problems.push('Both policies need a company-specific WITH CHECK');
 if ((sql.match(/USING \(company_id = nullif\(current_setting\('app.company_id',true\),''\)::uuid\)/g)||[]).length!==2) problems.push('Both policies need a company-specific USING');
 if(!sql.includes('NOT rolsuper AND NOT rolbypassrls')) problems.push('Restricted desk_app prerequisite missing');
 if(!sql.includes('ALTER TABLE landing_pages FORCE ROW LEVEL SECURITY') || !sql.includes('ALTER TABLE content_items FORCE ROW LEVEL SECURITY')) problems.push('FORCE RLS required');
 if(/GRANT [^;]* TO PUBLIC\b/i.test(sql)) problems.push('Public grants are forbidden');
 return problems;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const issues=validateMarketingMigration(readFileSync(CANDIDATE,'utf8'));
 if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}
 else console.log('Marketing candidate passed static RLS checks; no DB changes performed.');
}
