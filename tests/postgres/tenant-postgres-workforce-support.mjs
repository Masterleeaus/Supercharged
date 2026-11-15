/**
 * CI-only fixture for the workforce tenant isolation tests (migration 0014). Seeds one company-A row for each of the
 * 39 workforce tables, in dependency order, through the superuser pool. Company B gets no rows: every test asks
 * whether B can see or attach to A's data. Only rows for companies A and B are created or deleted here.
 */
import { randomUUID } from 'node:crypto';
import { A, B } from './tenant-postgres-support.mjs';

export { A, B };

const USER = '33333333-3333-4333-8333-333333333333';

// [table, reference name, column values]. A value starting with "@" points at an earlier row's id by reference name.
// Order is parents first, so reversing it deletes children first.
export const WORKFORCE_ROWS = [
  ['clients', 'client', { name: 'Client A' }],
  ['clients', 'client2', { name: 'Client A two' }],
  ['client_merge_suggestions', 'merge', { client_id: '@client', duplicate_client_id: '@client2' }],
  ['properties', 'property', { client_id: '@client', address: '1 Test Street' }],
  ['property_contacts', 'contact', { property_id: '@property', role: 'owner', external_name: 'Owner A' }],
  ['property_issues', 'propertyIssue', { property_id: '@property', area: 'roof', item_key: 'gutter', title: 'Gutter A' }],
  ['work_orders', 'workOrder', { client_id: '@client', property_id: '@property', title: 'Job A' }],
  ['visits', 'visit', { work_order_id: '@workOrder', scheduled_start: '2026-01-01T09:00:00Z', scheduled_end: '2026-01-01T10:00:00Z' }],
  ['visit_checklist_items', 'checklistItem', { visit_id: '@visit', section: 'exterior', item_key: 'roof', label: 'Roof A' }],
  ['visit_media', 'visitMedia', { visit_id: '@visit', category: 'before', filename: 'a.jpg', original_name: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 1, created_by: USER }],
  ['job_notes', 'jobNote', { work_order_id: '@workOrder', body: 'Note A' }],
  ['job_signoffs', 'signoff', { visit_id: '@visit', signer_name: 'Signer A' }],
  ['job_material_lines', 'materialLine', { work_order_id: '@workOrder', name: 'Screws A' }],
  ['inventory_items', 'inventoryItem', { name: 'Screws A' }],
  ['purchase_orders', 'purchaseOrder', { supplier_name: 'Supplier A' }],
  ['supplier_bills', 'supplierBill', { purchase_order_id: '@purchaseOrder', supplier_name: 'Supplier A', amount_cents: 100 }],
  ['end_of_lease_checklists', 'leaseChecklist', { property_id: '@property', title: 'Lease A' }],
  ['crew_rosters', 'crewRoster', { roster_date: '2026-01-01', team_name: 'Team A' }],
  ['timesheets', 'timesheet', { user_id: USER, work_date: '2026-01-01' }],
  ['timesheet_flags', 'timesheetFlag', { timesheet_id: '@timesheet', reason: 'Long day A' }],
  ['staff_tasks', 'staffTask', { title: 'Task A', work_order_id: '@workOrder', visit_id: '@visit' }],
  ['business_hours', 'businessHours', { day_of_week: 1, opens_at: '08:00', closes_at: '17:00' }],
  ['service_agreements', 'agreement', { client_id: '@client', property_id: '@property', name: 'Agreement A' }],
  ['maintenance_plans', 'plan', { client_id: '@client', property_id: '@property', name: 'Plan A', frequency: 'monthly' }],
  ['estimates', 'estimate', { client_id: '@client', property_id: '@property', work_order_id: '@workOrder' }],
  ['quote_requests', 'quoteRequest', { client_id: '@client', client_name: 'Client A', summary: 'Quote A' }],
  ['opportunities', 'opportunity', { client_id: '@client', title: 'Opportunity A' }],
  ['disputes', 'dispute', { client_id: '@client', summary: 'Dispute A' }],
  ['collection_notes', 'collectionNote', { client_id: '@client', invoice_ref: 'INV-A', body: 'Chase A' }],
  ['reviews', 'review', { client_id: '@client', rating: 5 }],
  ['review_alerts', 'reviewAlert', { review_id: '@review', summary: 'Alert A' }],
  ['feedback_responses', 'feedback', { visit_id: '@visit', client_id: '@client', rating: 4 }],
  ['complaints', 'complaint', { client_id: '@client', property_id: '@property', work_order_id: '@workOrder', summary: 'Complaint A' }],
  ['compliance_certificates', 'certificate', { property_id: '@property', certificate_type: 'electrical' }],
  ['compliance_documents', 'complianceDoc', { property_id: '@property', title: 'Doc A' }],
  ['pool_profiles', 'poolProfile', { property_id: '@property', name: 'Pool A' }],
  ['pool_equipment', 'poolEquipment', { pool_profile_id: '@poolProfile', kind: 'pump' }],
  ['pool_equipment_faults', 'poolFault', { pool_equipment_id: '@poolEquipment', summary: 'Leak A' }],
  ['water_tests', 'waterTest', { pool_profile_id: '@poolProfile', scheduled_for: '2026-01-02T09:00:00Z' }],
  ['water_test_results', 'waterResult', { water_test_id: '@waterTest', pool_profile_id: '@poolProfile' }],
];

/** Tables with no composite foreign key. Nothing in the schema stops a second company from inserting into them. */
export const ROOT_TABLES = new Set(['clients', 'inventory_items', 'purchase_orders', 'crew_rosters', 'timesheets', 'business_hours']);

/** Clears company A and B rows from every workforce table, children first. Other companies are not touched. */
export async function clearWorkforce(pool) {
  for (const [table] of [...WORKFORCE_ROWS].reverse()) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
  }
}

/** Inserts one company-A row per table. Returns a map of reference name to id. */
export async function seedCompanyA(pool) {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING', [A, 'Company A', B, 'Company B']);
  const refs = {};
  for (const [table, ref, values] of WORKFORCE_ROWS) {
    const id = randomUUID();
    refs[ref] = id;
    const resolved = {};
    for (const [column, value] of Object.entries(values)) {
      resolved[column] = typeof value === 'string' && value.startsWith('@') ? refs[value.slice(1)] : value;
    }
    const columns = ['company_id', 'id', ...Object.keys(resolved)];
    const params = [A, id, ...Object.values(resolved)];
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, params);
  }
  return refs;
}

/** Insert the same row as company `companyId` with the same parent references. Used by the cross-company test. */
export function copyInsertFor(table, ref, refs, companyId) {
  const entry = WORKFORCE_ROWS.find((row) => row[0] === table && row[1] === ref);
  if (!entry) throw new Error(`no fixture for ${table}/${ref}`);
  const resolved = {};
  for (const [column, value] of Object.entries(entry[2])) {
    resolved[column] = typeof value === 'string' && value.startsWith('@') ? refs[value.slice(1)] : value;
  }
  const columns = ['company_id', 'id', ...Object.keys(resolved)];
  const params = [companyId, randomUUID(), ...Object.values(resolved)];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  return { sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, params };
}
