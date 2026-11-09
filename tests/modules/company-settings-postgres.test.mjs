// Company quiet-hours store, Postgres adapter. Checks that a saved value survives a new adapter
// instance on the same database, that one company cannot read or change another's row, and that
// set, update and clear behave. Uses a fake pool, not a real database, so no network.
// The fake pool checks the session tenant the way withTenant sets it (BEGIN, SET LOCAL ROLE,
// set_config). A data query for another company than the session's fails, as row-level security would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';

function createFakeQuietHoursDb() {
  const rows = new Map(); // company_id -> row, shared by every connection, like one table
  const statements = [];
  let released = 0;

  const connection = () => {
    const state = { tenant: null, role: null, inTx: false };
    return {
      async query(text, values = []) {
        const sqlText = text.trim();
        statements.push({ text: sqlText, values: [...values], tenant: state.tenant });
        if (sqlText === 'BEGIN') { state.inTx = true; return { rows: [] }; }
        if (sqlText === 'COMMIT' || sqlText === 'ROLLBACK') { state.inTx = false; return { rows: [] }; }
        if (sqlText.startsWith('SET LOCAL ROLE')) { state.role = sqlText.match(/"(.+)"/)[1]; return { rows: [] }; }
        if (sqlText.startsWith('SELECT set_config')) {
          assert.equal(values[0], 'app.company_id');
          state.tenant = values[1];
          return { rows: [{ set_config: values[1] }] };
        }
        if (!state.inTx) throw new Error('data query outside a tenant transaction');
        if (values[0] !== state.tenant) throw new Error('row-level security: query company differs from session company');

        if (sqlText.startsWith('INSERT INTO company_quiet_hours')) {
          const [companyId, startHour, endHour, timezone, updatedAt] = values;
          const row = { company_id: companyId, start_hour: startHour, end_hour: endHour, timezone, updated_at: new Date(updatedAt) };
          rows.set(companyId, row);
          return { rows: [{ ...row }] };
        }
        if (sqlText.startsWith('SELECT company_id')) {
          const row = rows.get(values[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        if (sqlText.startsWith('DELETE FROM company_quiet_hours')) {
          const existed = rows.delete(values[0]);
          return { rows: existed ? [{ company_id: values[0] }] : [] };
        }
        throw new Error(`unexpected statement: ${sqlText}`);
      },
      release() { released += 1; },
    };
  };

  return {
    pool: { async connect() { return connection(); } },
    rows,
    statements,
    get released() { return released; },
  };
}

function clockAt(iso) {
  return () => new Date(iso);
}

test('a saved value is still there for a new adapter instance on the same database', async () => {
  const db = createFakeQuietHoursDb();
  const first = createCompanySettingsStore({ pool: db.pool, now: clockAt('2026-11-03T00:00:00.000Z') });
  const set = await first.setQuietHours(CO_A, { startHour: 21, endHour: 7, timezone: 'Australia/Melbourne' });
  assert.equal(set.ok, true);

  // A second instance stands in for a restarted process or another server instance.
  const second = createCompanySettingsStore({ pool: db.pool });
  assert.deepEqual(await second.getQuietHours(CO_A), {
    ok: true,
    settings: {
      companyId: CO_A,
      startHour: 21,
      endHour: 7,
      timezone: 'Australia/Melbourne',
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
  });
  const ends = db.statements.filter((s) => s.text === 'COMMIT' || s.text === 'ROLLBACK').length;
  assert.equal(db.released, ends, 'every connection is released');
});

test("company A cannot read or change company B's settings", async () => {
  const db = createFakeQuietHoursDb();
  const store = createCompanySettingsStore({ pool: db.pool, now: clockAt('2026-11-03T00:00:00.000Z') });
  await store.setQuietHours(CO_A, { startHour: 21, endHour: 7, timezone: 'UTC' });
  await store.setQuietHours(CO_B, { startHour: 1, endHour: 2, timezone: 'Europe/London' });

  // Each read and write runs in its own tenant transaction for the company it names.
  assert.equal((await store.getQuietHours(CO_B)).settings.startHour, 1);
  const readStatements = db.statements.filter((s) => s.text.startsWith('SELECT company_id'));
  assert.equal(readStatements.at(-1).tenant, CO_B);
  assert.equal(readStatements.at(-1).values[0], CO_B);

  // Clearing A leaves B's row alone.
  assert.deepEqual(await store.clearQuietHours(CO_A), { ok: true, cleared: true });
  assert.equal((await store.getQuietHours(CO_A)).settings, null);
  assert.equal((await store.getQuietHours(CO_B)).settings.timezone, 'Europe/London');

  // A's update writes only A's row.
  await store.setQuietHours(CO_A, { startHour: 9, endHour: 10, timezone: 'UTC' });
  assert.equal((await store.getQuietHours(CO_B)).settings.startHour, 1);
  assert.equal(db.rows.size, 2);
});

test('the company key is lowercase, so the same company in either case shares one row', async () => {
  const db = createFakeQuietHoursDb();
  const store = createCompanySettingsStore({ pool: db.pool });
  await store.setQuietHours(CO_A.toUpperCase(), { startHour: 3, endHour: 4, timezone: 'UTC' });
  assert.equal((await store.getQuietHours(CO_A)).settings.startHour, 3);
  assert.equal(db.rows.size, 1);
});

test('set, update and clear behave: update replaces the values and updatedAt, clear is idempotent', async () => {
  const db = createFakeQuietHoursDb();
  const early = createCompanySettingsStore({ pool: db.pool, now: clockAt('2026-11-03T00:00:00.000Z') });
  const late = createCompanySettingsStore({ pool: db.pool, now: clockAt('2026-11-04T12:00:00.000Z') });

  await early.setQuietHours(CO_A, { startHour: 21, endHour: 7, timezone: 'UTC' });
  const updated = await late.setQuietHours(CO_A, { startHour: 1, endHour: 2, timezone: 'Pacific/Auckland' });
  assert.deepEqual(updated.settings, {
    companyId: CO_A,
    startHour: 1,
    endHour: 2,
    timezone: 'Pacific/Auckland',
    updatedAt: '2026-11-04T12:00:00.000Z',
  });
  assert.equal(db.rows.size, 1);

  assert.deepEqual(await late.clearQuietHours(CO_A), { ok: true, cleared: true });
  assert.deepEqual(await late.getQuietHours(CO_A), { ok: true, settings: null });
  assert.deepEqual(await late.clearQuietHours(CO_A), { ok: true, cleared: false });
});

test('invalid input is refused before any database work', async () => {
  const db = createFakeQuietHoursDb();
  const store = createCompanySettingsStore({ pool: db.pool });
  assert.deepEqual(await store.setQuietHours('not-a-uuid', { startHour: 1, endHour: 2, timezone: 'UTC' }), { ok: false, reason: 'invalid_company' });
  assert.deepEqual(await store.getQuietHours(CO_A.slice(0, -1)), { ok: false, reason: 'invalid_company' });
  assert.deepEqual(await store.setQuietHours(CO_A, { startHour: 25, endHour: 2, timezone: 'UTC' }), { ok: false, reason: 'invalid_hour' });
  assert.deepEqual(await store.setQuietHours(CO_A, { startHour: 1, endHour: 2, timezone: 'Mars/Olympus' }), { ok: false, reason: 'invalid_timezone' });
  assert.equal(db.statements.length, 0);
});

test('the store needs a pool or the explicit test option, and the in-memory adapter is refused in production', () => {
  assert.throws(() => createCompanySettingsStore({}), TypeError);
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createCompanySettingsStore({ memoryForTests: true }), /test-only/);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});
