// PostgreSQL persistence for the durable suppression list (createDurableSuppressionList).
// Tables: comms_suppressions and comms_soft_bounces (migration 0022). Every read and write runs
// through withTenant, so the session carries the company and the row-level policy applies. The
// company id is also filtered on explicitly.

import { withTenant, type TenantPool } from '../../infrastructure/database/tenant-context.ts';
import type { SuppressionPersistence, SuppressionRows, SuppressionWrite } from './suppression.ts';

export interface PostgresSuppressionOptions {
  /** The app pool. Each call takes its own connection through withTenant. */
  pool: TenantPool;
}

export function createPostgresSuppressionPersistence(options: PostgresSuppressionOptions): SuppressionPersistence {
  const pool = options?.pool;
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool_required');

  return {
    async load(companyId: string): Promise<SuppressionRows> {
      return withTenant(pool, companyId, async (client) => {
        const suppressions = await client.query(
          `SELECT channel, address, reason FROM comms_suppressions WHERE company_id = $1`,
          [companyId],
        );
        const softBounces = await client.query(
          `SELECT channel, address, count FROM comms_soft_bounces WHERE company_id = $1`,
          [companyId],
        );
        return {
          suppressions: suppressions.rows.map((row) => ({
            channel: row.channel,
            address: row.address,
            reason: row.reason,
          })),
          softBounces: softBounces.rows.map((row) => ({
            channel: row.channel,
            address: row.address,
            count: Number(row.count),
          })),
        };
      });
    },

    async write(change: SuppressionWrite): Promise<void> {
      await withTenant(pool, change.companyId, async (client) => {
        const { companyId, channel, address } = change;
        if (change.op === 'suppressed') {
          await client.query(
            `INSERT INTO comms_suppressions (company_id, channel, address, reason)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (company_id, channel, address)
             DO UPDATE SET reason = EXCLUDED.reason, updated_at = now()`,
            [companyId, channel, address, change.reason],
          );
          // A suppression replaces any pending soft-bounce count for the same address.
          await client.query(
            `DELETE FROM comms_soft_bounces WHERE company_id = $1 AND channel = $2 AND address = $3`,
            [companyId, channel, address],
          );
        } else if (change.op === 'soft_bounce') {
          await client.query(
            `INSERT INTO comms_soft_bounces (company_id, channel, address, count)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (company_id, channel, address)
             DO UPDATE SET count = EXCLUDED.count, updated_at = now()`,
            [companyId, channel, address, change.count],
          );
        } else {
          await client.query(
            `DELETE FROM comms_suppressions WHERE company_id = $1 AND channel = $2 AND address = $3`,
            [companyId, channel, address],
          );
          await client.query(
            `DELETE FROM comms_soft_bounces WHERE company_id = $1 AND channel = $2 AND address = $3`,
            [companyId, channel, address],
          );
        }
        return null;
      });
    },
  };
}
