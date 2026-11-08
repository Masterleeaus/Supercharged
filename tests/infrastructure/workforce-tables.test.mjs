/**
 * Static check of migrations/0014_workforce_tool_tables.sql.
 *
 * Every table the workforce tool handlers need must carry:
 *   - company_id uuid NOT NULL
 *   - a foreign key from company_id to companies(id)
 *   - an index whose leading column is company_id
 *
 * Reads the SQL file only. It does not connect to any database.
 *
 *   node --test tests/infrastructure/workforce-tables.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIGRATION = new URL('../../migrations/0014_workforce_tool_tables.sql', import.meta.url);
const sql = readFileSync(MIGRATION, 'utf8');

const NEW_TABLES = [
  'clients',
  'client_merge_suggestions',
  'properties',
  'property_contacts',
  'property_issues',
  'work_orders',
  'visits',
  'visit_checklist_items',
  'visit_media',
  'job_notes',
  'job_signoffs',
  'job_material_lines',
  'inventory_items',
  'purchase_orders',
  'supplier_bills',
  'end_of_lease_checklists',
  'crew_rosters',
  'timesheets',
  'timesheet_flags',
  'staff_tasks',
  'business_hours',
  'service_agreements',
  'maintenance_plans',
  'estimates',
  'quote_requests',
  'opportunities',
  'disputes',
  'collection_notes',
  'reviews',
  'review_alerts',
  'feedback_responses',
  'complaints',
  'compliance_certificates',
  'compliance_documents',
  'pool_profiles',
  'pool_equipment',
  'pool_equipment_faults',
  'water_tests',
  'water_test_results',
];

/** Returns the body of CREATE TABLE IF NOT EXISTS <name> (...); or null. */
function tableBlock(name) {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\);`);
  const m = sql.match(re);
  return m ? m[1] : null;
}

test('the migration defines every workforce table exactly once', () => {
  for (const name of NEW_TABLES) {
    const count = sql.split(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(`)).length - 1;
    assert.equal(count, 1, `${name} should be created exactly once, found ${count}`);
  }
});

for (const name of NEW_TABLES) {
  test(`${name}: company_id is uuid NOT NULL`, () => {
    const block = tableBlock(name);
    assert.ok(block, `${name} block not found`);
    assert.match(block, /\bcompany_id\s+uuid\s+NOT NULL\b/, `${name} company_id must be uuid NOT NULL`);
  });

  test(`${name}: company_id references companies(id)`, () => {
    const block = tableBlock(name);
    assert.ok(block, `${name} block not found`);
    assert.match(block, /\bREFERENCES\s+companies\s*\(\s*id\s*\)/, `${name} must reference companies(id)`);
  });

  test(`${name}: has an index led by company_id`, () => {
    const re = new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS \\S+\\s+ON ${name}\\s*\\(\\s*company_id\\b`);
    assert.match(sql, re, `${name} needs an index whose first column is company_id`);
  });
}
