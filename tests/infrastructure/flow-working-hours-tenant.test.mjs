// Issue #252: the working-hours read in flow-automation/shared.ts runs inside a tenant transaction.
// No database is reached. A pg.Pool subclass records the statements drizzle sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { withTenantTransaction } from '../../server/infrastructure/database/tenant-transaction.ts';
import { appointmentSettings } from '../../shared/schema.ts';
import { and, eq } from 'drizzle-orm';

const COMPANY = '6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51';
const USER = 'user-1';

class RecordingPool extends pg.Pool {
  constructor() {
    super({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
    this.statements = [];
  }
  async connect() {
    const log = this.statements;
    return {
      async query(text, values) {
        log.push({ text: typeof text === 'string' ? text : text.text, values });
        return { rows: [], rowCount: 0, fields: [] };
      },
      release() {},
    };
  }
}

// Same statement shape as validateWorkingHours in server/routes/flow-automation/shared.ts.
function readSettings(db, userId, companyId) {
  return withTenantTransaction(db, companyId, (tx) =>
    tx.select().from(appointmentSettings).where(and(eq(appointmentSettings.userId, userId), eq(appointmentSettings.companyId, companyId))),
  );
}

test('working-hours read sets app.company_id before the appointment settings query', async () => {
  const pool = new RecordingPool();
  const db = drizzle(pool);
  await readSettings(db, USER, COMPANY);
  const sqlText = pool.statements.map((s) => s.text);
  assert.match(sqlText[0], /begin/i);
  assert.match(sqlText[1], /set_config/i);
  assert.deepEqual(pool.statements[1].values, ['app.company_id', COMPANY]);
  assert.match(sqlText[2], /appointment_settings/i);
  await pool.end();
});

test('working-hours read refuses a non-UUID company id before any statement is sent', async () => {
  const pool = new RecordingPool();
  const db = drizzle(pool);
  await assert.rejects(readSettings(db, USER, 'not-a-company'), /companyId must be a UUID/);
  assert.equal(pool.statements.length, 0);
  await pool.end();
});

test('validateWorkingHours no longer reads appointment settings through the bare db handle', () => {
  const source = readFileSync(new URL('../../server/routes/flow-automation/shared.ts', import.meta.url), 'utf8');
  assert.match(source, /withTenantTransaction\(db, companyId/);
  assert.doesNotMatch(source, /await db\s*\.select\(\)\s*\.from\(appointmentSettings\)/);
});
