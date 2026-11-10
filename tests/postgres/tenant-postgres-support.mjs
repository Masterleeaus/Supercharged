/** Real PostgreSQL fixture for CI-only tenant isolation tests (Settings quiet hours). */
import pg from 'pg';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const enabled = process.env.TENANT_PG_DISPOSABLE === 'true' && Boolean(process.env.TENANT_PG_INTEGRATION_URL);
export function fixture() {
  if (!enabled) throw new Error('Disposable tenant PostgreSQL fixture must be explicitly enabled');
  const pool = new pg.Pool({ connectionString: process.env.TENANT_PG_INTEGRATION_URL, max: 4 });
  return { pool, settings: createCompanySettingsStore({ pool }), close: () => pool.end() };
}
