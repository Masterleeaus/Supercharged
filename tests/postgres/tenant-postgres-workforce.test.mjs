import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createGroup00ToolDefinitions } from '../../server/workforce/tools/handlers/group-00.ts';
import { createGroup02ToolDefinitions } from '../../server/workforce/tools/handlers/group-02.ts';
import { createGroup03ToolDefinitions } from '../../server/workforce/tools/handlers/group-03.ts';
import { createGroup04ToolDefinitions } from '../../server/workforce/tools/handlers/group-04.ts';
import { A, B, enabled } from './tenant-postgres-support.mjs';
import {
  ROOT_TABLES,
  WORKFORCE_ROWS,
  clearWorkforce,
  copyInsertFor,
  seedCompanyA,
} from './tenant-postgres-workforce-support.mjs';

const connectionString = process.env.TENANT_PG_INTEGRATION_URL;

// Part 1: composite foreign keys. Company B tries to insert a row that points at company A's parent.
describe('PostgreSQL workforce: composite foreign keys stop cross-company attachment', { skip: !enabled }, () => {
  let pool;
  let refs;

  before(async () => {
    pool = new pg.Pool({ connectionString, max: 4 });
    await clearWorkforce(pool);
    refs = await seedCompanyA(pool);
  });

  after(async () => {
    await clearWorkforce(pool);
    await pool.end();
  });

  const seen = new Set();
  for (const [table, ref] of WORKFORCE_ROWS) {
    if (seen.has(table)) continue;
    seen.add(table);
    if (ROOT_TABLES.has(table)) {
      it(`${table}: no composite foreign key to a parent`, {
        todo: 'root table with no parent key; company isolation rests on handler scoping (see part 2)',
      }, () => {});
      continue;
    }
    it(`${table}: company B cannot attach a row to company A's parent`, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const attempt = copyInsertFor(table, ref, refs, B);
        await client.query('SAVEPOINT cross_company');
        await assert.rejects(client.query(attempt.sql, attempt.params), (error) => error.code === '23503');
        await client.query('ROLLBACK TO SAVEPOINT cross_company');
        // Control: the same insert as company A must not fail on the foreign key, so the rejection is about company.
        const control = copyInsertFor(table, ref, refs, A);
        await client.query('SAVEPOINT same_company');
        await client.query(control.sql, control.params).catch((error) => {
          assert.notEqual(error.code, '23503', `control insert for ${table} failed its foreign key as company A`);
          return client.query('ROLLBACK TO SAVEPOINT same_company');
        });
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  }
});

// Part 2: handler reads. Real workforce handlers run as company B against company A's data.
describe('PostgreSQL workforce: handler reads stay inside the caller company', { skip: !enabled }, () => {
  let pool;
  let refs;
  let defs00;
  let defs02;
  let defs03;
  let defs04;

  before(async () => {
    pool = new pg.Pool({ connectionString, max: 4 });
    await clearWorkforce(pool);
    refs = await seedCompanyA(pool);
    defs00 = createGroup00ToolDefinitions(pool);
    defs02 = createGroup02ToolDefinitions({ db: pool });
    defs03 = createGroup03ToolDefinitions({ sql: pool });
    defs04 = createGroup04ToolDefinitions({ db: pool });
  });

  after(async () => {
    await clearWorkforce(pool);
    await pool.end();
  });

  async function call(defs, toolId, params, companyId) {
    const def = defs.find((d) => d.id === toolId);
    assert.ok(def, `tool ${toolId} is registered`);
    return def.handler(params, { companyId, signal: AbortSignal.timeout(10_000) });
  }

  const cases = [
    { table: 'clients', tool: 'clients.list', defs: () => defs00, params: () => ({}), ref: 'client' },
    { table: 'clients', tool: 'clients.get', defs: () => defs00, params: () => ({ id: refs.client }), ref: 'client' },
    { table: 'properties', tool: 'properties.list', defs: () => defs02, params: () => ({}), ref: 'property' },
    { table: 'property_contacts', tool: 'property_contacts.list', defs: () => defs02, params: () => ({ propertyId: refs.property }), ref: 'contact' },
    { table: 'pool_profiles', tool: 'pool_profiles.list', defs: () => defs02, params: () => ({ propertyId: refs.property }), ref: 'poolProfile' },
    { table: 'pool_equipment', tool: 'pool_equipment.list', defs: () => defs02, params: () => ({ poolProfileId: refs.poolProfile }), ref: 'poolEquipment' },
    { table: 'job_material_lines', tool: 'parts_lists.list', defs: () => defs02, params: () => ({ workOrderId: refs.workOrder }), ref: 'materialLine' },
    { table: 'crew_rosters', tool: 'crew_rosters.list', defs: () => defs00, params: () => ({}), ref: 'crewRoster' },
    { table: 'purchase_orders', tool: 'purchase_orders.list', defs: () => defs03, params: () => ({}), ref: 'purchaseOrder' },
    { table: 'timesheets', tool: 'timesheets.list', defs: () => defs04, params: () => ({}), ref: 'timesheet' },
    // Monday 2026-01-05 matches the fixture's day_of_week = 1.
    // The availability output carries no row id, so the opening time is the marker for company A's window.
    { table: 'business_hours', tool: 'availability.read', defs: () => defs00, params: () => ({ date: '2026-01-05' }), needle: '"opensAt":"08:00"' },
  ];

  for (const c of cases) {
    it(`${c.table}: company B reads no company A row through ${c.tool}`, async () => {
      const asB = await call(c.defs(), c.tool, c.params(), B).catch((error) => ({ refused: error.message }));
      const needle = c.needle ?? refs[c.ref];
      assert.ok(!JSON.stringify(asB).includes(needle), `${c.tool} leaked a company A row to company B`);
      // Control: company A sees its own row through the same tool, so the empty result is not a broken fixture.
      const asA = await call(c.defs(), c.tool, c.params(), A);
      assert.ok(JSON.stringify(asA).includes(needle), `${c.tool} did not return company A's own row`);
    });
  }

  // Not covered by a read tool that returns rows. inventory.stock.list is not_implemented; staff_tasks is only
  // counted (group-03 dashboard) and written (group-04), never listed.
  it('inventory_items: handler read isolation not covered yet', {
    todo: 'inventory.stock.list is not_implemented; no list tool returns inventory rows',
  }, () => {});
  it('staff_tasks: handler read isolation not covered yet', {
    todo: 'staff_tasks has no list tool; group-03 only counts open tasks',
  }, () => {});
});
