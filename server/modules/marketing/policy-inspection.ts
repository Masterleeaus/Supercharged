/**
 * Conservative inspection of PostgreSQL RLS metadata.
 * Permissive policies combine using OR, so any additional permissive rule
 * is rejected regardless of role membership (which could change over time).
 */
export interface MarketingPolicyRow {
 tablename?: unknown; policyname?: unknown; roles?: unknown; cmd?: unknown;
 permissive?: unknown; qual?: unknown; with_check?: unknown;
}
export function postgresPolicyRoles(value: unknown): string[] {
 if (Array.isArray(value) && value.every(x=>typeof x==='string')) return value.map(x=>x.toLowerCase());
 if (typeof value !== 'string' || !/^\{[a-z_][a-z0-9_]*(?:,[a-z_][a-z0-9_]*)*\}$/i.test(value)) return [];
 return value.slice(1,-1).split(',').map(x=>x.toLowerCase());
}
export function tenantPredicate(value: unknown): boolean {
 if (typeof value !== 'string') return false;
 const normalized=value.toLowerCase().replace(/::text\b/g,'').replace(/[()\s]/g,'');
 return normalized === "company_id=nullifcurrent_setting'app.company_id',true,''::uuid";
}
export function inspectMarketingPolicies(table: string, rows: MarketingPolicyRow[]): string[] {
 const issues:string[]=[];
 const relevant=rows.filter(r=>r.tablename===table);
 const expected=relevant.find(r=>r.policyname===table+'_tenant_boundary');
 if (!expected) return [table+' tenant policy missing'];
 const roles=postgresPolicyRoles(expected.roles);
 if (!roles.includes('desk_app') || roles.includes('public') ||
     expected.cmd !== 'ALL' || expected.permissive !== 'PERMISSIVE' ||
     !tenantPredicate(expected.qual) || !tenantPredicate(expected.with_check)) {
   issues.push(table+' tenant policy must be permissive ALL with exact tenant predicates');
 }
 // Any other PERMISSIVE rule may become relevant via role inheritance, membership
 // changes or PUBLIC, so no additional permissive rule is accepted.
 for (const row of relevant) {
  if (row===expected) continue;
  if (row.permissive !== 'RESTRICTIVE') {
   issues.push(table+' has additional permissive or unrecognised policy '+String(row.policyname));
  }
  if (postgresPolicyRoles(row.roles).length===0) {
   issues.push(table+' has policy with unknown role encoding');
  }
 }
 return issues;
}
