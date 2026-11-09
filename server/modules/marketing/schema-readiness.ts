/**
 * Database readiness checks for a Marketing deployment.
 * The verifier runs with the deployment's privileged migration/check connection,
 * not with the tenant role. It never mutates schemas or starts the service.
 */
export interface MarketingSchemaProbe {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface MarketingReadiness {
  ready: boolean;
  issues: string[];
}
const TABLES = ['landing_pages','content_items'] as const;
export async function verifyMarketingSchema(probe: MarketingSchemaProbe): Promise<MarketingReadiness> {
  if (!probe || typeof probe.query !== 'function') throw new Error('marketing: schema probe is required');
  const issues: string[] = [];
  const role = await probe.query(
    "SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname = $1",
    ['desk_app'],
  );
  const app = role.rows[0];
  if (!app) issues.push('restricted desk_app role missing');
  else {
    if (app.rolsuper !== false) issues.push('desk_app must not be superuser');
    if (app.rolbypassrls !== false) issues.push('desk_app must not bypass RLS');
  }
  const tables = await probe.query(
    `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
            has_table_privilege('desk_app',c.oid,'SELECT') AS can_select,
            has_table_privilege('desk_app',c.oid,'INSERT') AS can_insert,
            has_table_privilege('desk_app',c.oid,'UPDATE') AS can_update
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1::text[])`,
    [TABLES],
  );
  for (const table of TABLES) {
    const row = tables.rows.find(r => r.relname === table);
    if (!row) { issues.push(table + ' missing'); continue; }
    if (row.relrowsecurity !== true || row.relforcerowsecurity !== true) issues.push(table + ' must enforce and FORCE RLS');
    if (app && (row.can_select !== true || row.can_insert !== true || row.can_update !== true)) issues.push(table + ' missing restricted role permissions');
  }
  const policies = await probe.query(
    `SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
       WHERE schemaname='public' AND tablename = ANY($1::text[])`,
    [TABLES],
  );
  for (const table of TABLES) {
    const policy = policies.rows.find(r => r.tablename === table && r.policyname === table + '_tenant_boundary');
    if (!policy) { issues.push(table + ' tenant policy missing'); continue; }
    if (!Array.isArray(policy.roles) || !policy.roles.includes('desk_app') ||
        !String(policy.qual ?? '').includes('app.company_id') ||
        !String(policy.with_check ?? '').includes('app.company_id')) {
      issues.push(table + ' tenant policy does not constrain both reads and writes');
    }
  }
  return { ready: issues.length === 0, issues };
}
export async function requireMarketingSchema(probe: MarketingSchemaProbe): Promise<void> {
  const result = await verifyMarketingSchema(probe);
  if (!result.ready) throw new Error('marketing: database security not ready: ' + result.issues.join('; '));
}
