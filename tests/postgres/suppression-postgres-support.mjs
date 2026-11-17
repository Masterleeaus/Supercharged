/** Real PostgreSQL fixture for the durable comms suppression tests. CI-only or disposable databases. */
import pg from 'pg';
import { createPostgresSuppressionPersistence } from '../../server/modules/comms/suppression-postgres.ts';

export const enabled =
  process.env.SUPPRESSION_PG_DISPOSABLE === 'true' && Boolean(process.env.SUPPRESSION_PG_INTEGRATION_URL);

export function fixture() {
  if (!enabled) throw new Error('Disposable suppression PostgreSQL fixture must be explicitly enabled');
  const pool = new pg.Pool({ connectionString: process.env.SUPPRESSION_PG_INTEGRATION_URL, max: 4 });
  return {
    pool,
    persistence: createPostgresSuppressionPersistence({ pool }),
    close: () => pool.end(),
  };
}
