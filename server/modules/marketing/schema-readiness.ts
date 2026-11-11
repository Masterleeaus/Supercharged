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
import { inspectMarketingPolicies } from './policy-inspection.ts';
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
            CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN has_table_privilege('desk_app',c.oid,'SELECT') ELSE false END AS can_select,
            CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN has_table_privilege('desk_app',c.oid,'INSERT') ELSE false END AS can_insert,
            CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='desk_app') THEN has_table_privilege('desk_app',c.oid,'UPDATE') ELSE false END AS can_update
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
    `SELECT tablename,policyname,roles,cmd,permissive,qual,with_check FROM pg_policies
       WHERE schemaname='public' AND tablename = ANY($1::text[])`,
    [TABLES],
  );
  for (const table of TABLES) issues.push(...inspectMarketingPolicies(table, policies.rows));
  return { ready: issues.length === 0, issues };
}
export async function requireMarketingSchema(probe: MarketingSchemaProbe): Promise<void> {
  const result = await verifyMarketingSchema(probe);
  if (!result.ready) throw new Error('marketing: database security not ready: ' + result.issues.join('; '));
}
