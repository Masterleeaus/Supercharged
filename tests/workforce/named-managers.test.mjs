/**
 * Issue #50: Hub, Go and Command are separate named Manager agents with their own audience, tool set and
 * refusals. These tests read the real role catalogue and pin, for each Manager:
 *   - the exact tool set it may be given (allowed actions);
 *   - tools it must never hold (refused actions), by audience;
 *   - the owner-approval rule (money and customer sends) and the safety escalation path;
 *   - that no Manager holds a customer-send tool, and that only Command holds a money tool.
 * Run: node --test --experimental-transform-types tests/workforce/named-managers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { ALWAYS_APPROVAL_BY_CATEGORY, isAlwaysApproval } = await import(
  '../../server/workforce/runtime/always-approval.ts'
);
const { TOOL_ACCESS } = await import('../../server/workforce/catalogue/tool-access.ts');

const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles', import.meta.url));
const catalogue = await loadRoleCatalogue(ROLES_DIR);

const HUB = 'hub-manager';
const GO = 'go-manager';
const COMMAND = 'command-manager';
const MANAGERS = [HUB, GO, COMMAND];

const role = (id) => {
  const found = catalogue.get(id);
  assert.ok(found, `role ${id} must be in the catalogue`);
  return found;
};

const EXPECTED_TOOLS = {
  [HUB]: [
    'clients.get',
    'availability.read',
    'booking_requests.get',
    'booking_requests.create',
    'quote_requests.create',
    'complaints.create',
    'customer_messages.draft',
    'safety.escalate_to_human',
  ],
  [GO]: [
    'work_orders.list',
    'work_orders.start_visit',
    'visits.get',
    'visits.transition',
    'job_checklists.list',
    'job_notes.create',
    'job_photos.list',
    'job_signoff.record',
    'work_notes.list',
    'materials.check',
    'parts_lists.list',
    'sites.list',
    'property_issues.create',
    'technician_tasks.create',
    'safety.escalate_to_human',
  ],
  [COMMAND]: [
    'booking_requests.list',
    'work_orders.list',
    'service_visits.list',
    'service_visits.reschedule',
    'crew_rosters.list',
    'crew_rosters.update',
    'timesheets.list',
    'timesheet_flags.create',
    'invoices.list',
    'payments.list',
    'quotes.list',
    'estimates.list',
    'purchase_orders.list',
    'purchase_orders.draft',
    'supplier_bills.list',
    'reviews.list',
    'review_alerts.create',
    'staff_tasks.create',
    'users.list',
    'inventory.list',
    'compliance_documents.list',
    'safety.escalate_to_human',
  ],
};

// Tools a Manager of this audience must be refused. Each list is checked against the role's tools.
const REFUSED = {
  // Customers must not reach money, owner, staff, field-execution or customer-send tools.
  [HUB]: [
    'invoices.list',
    'payments.list',
    'refund_requests.create',
    'payment_plans.propose',
    'purchase_orders.draft',
    'staff_tasks.create',
    'crew_rosters.update',
    'timesheets.list',
    'work_orders.start_visit',
    'visits.transition',
    'job_signoff.record',
    'messages.send',
    'customer_messages.send',
    'reviews.request',
  ],
  // Field technicians must not reach customer-financial, purchasing, owner or customer-send tools.
  [GO]: [
    'invoices.list',
    'payments.list',
    'quotes.list',
    'estimates.list',
    'purchase_orders.draft',
    'purchase_orders.list',
    'supplier_bills.list',
    'users.list',
    'timesheets.list',
    'clients.get',
    'booking_requests.create',
    'quote_requests.create',
    'complaints.create',
    'customer_messages.draft',
    'customer_messages.send',
    'messages.send',
    'job_signoff.request',
    'refund_requests.create',
  ],
  // The owner's Manager must not send to customers directly, and must not hold a refund or payment action.
  [COMMAND]: [
    'messages.send',
    'customer_messages.send',
    'messages.send_customer',
    'feedback_surveys.send',
    'compliance_reminders.send',
    'job_signoff.request',
    'reviews.request',
    'refund_requests.create',
    'refund_requests.prepare',
    'payment_plans.propose',
  ],
};

test('exactly the three named Managers exist, with distinct names and company scope', () => {
  const names = MANAGERS.map((id) => role(id).name);
  assert.deepEqual(names, ['Hub Manager', 'Go Manager', 'Command Manager']);
  assert.equal(new Set(names).size, 3);
  for (const id of MANAGERS) assert.equal(role(id).companyScope, 'required', `${id} must be company scoped`);
});

for (const id of MANAGERS) {
  test(`${id} holds exactly its allowed tool set`, () => {
    assert.deepEqual([...role(id).tools].sort(), [...EXPECTED_TOOLS[id]].sort());
  });

  test(`${id} is refused every tool outside its audience`, () => {
    const held = new Set(role(id).tools);
    const leaked = REFUSED[id].filter((toolId) => held.has(toolId));
    assert.deepEqual(leaked, [], `${id} must not hold: ${leaked.join(', ')}`);
  });

  test(`${id} declares access that matches TOOL_ACCESS for every tool`, () => {
    const r = role(id);
    for (const toolId of r.tools) {
      assert.equal(r.toolAccess[toolId], TOOL_ACCESS[toolId], `${id} access for ${toolId}`);
    }
  });

  test(`${id} has a safety escalation path and a handoff that resolves`, () => {
    const r = role(id);
    assert.ok(r.tools.includes('safety.escalate_to_human'), `${id} must escalate safety issues`);
    for (const target of r.handoffTo) {
      assert.ok(catalogue.has(target), `${id} handoff ${target} must be a catalogue role`);
      assert.notEqual(target, id);
    }
  });

  test(`${id} gates every always-approval tool at critical risk`, () => {
    const r = role(id);
    for (const toolId of r.tools.filter((t) => isAlwaysApproval(t))) {
      assert.equal(r.toolRisk[toolId], 'critical', `${id}: ${toolId} must be critical`);
    }
  });
}

test('no Manager holds a customer-send tool', () => {
  const sends = new Set(ALWAYS_APPROVAL_BY_CATEGORY.customer_send);
  for (const id of MANAGERS) {
    const held = role(id).tools.filter((toolId) => sends.has(toolId));
    assert.deepEqual(held, [], `${id} must not hold customer-send tools`);
  }
});

test('only Command holds a money tool, and only the purchase order draft', () => {
  const money = new Set(ALWAYS_APPROVAL_BY_CATEGORY.money);
  for (const id of [HUB, GO]) {
    assert.deepEqual(role(id).tools.filter((toolId) => money.has(toolId)), [], `${id} must hold no money tool`);
  }
  assert.deepEqual(role(COMMAND).tools.filter((toolId) => money.has(toolId)), ['purchase_orders.draft']);
});

test('Hub and Go hold no owner-only write tools; Command holds the owner-side writes', () => {
  const ownerWrites = ['staff_tasks.create', 'crew_rosters.update', 'purchase_orders.draft', 'review_alerts.create'];
  for (const id of [HUB, GO]) {
    assert.deepEqual(role(id).tools.filter((toolId) => ownerWrites.includes(toolId)), [], `${id} owner-write leak`);
  }
  assert.deepEqual(ownerWrites.filter((toolId) => role(COMMAND).tools.includes(toolId)).sort(), [...ownerWrites].sort());
});

test('each Manager has a distinct system prompt that names its audience', () => {
  assert.match(role(HUB).systemPrompt, /You are the Hub Manager/);
  assert.match(role(GO).systemPrompt, /You are the Go Manager/);
  assert.match(role(COMMAND).systemPrompt, /You are the Command Manager/);
  assert.match(role(GO).systemPrompt, /assigned/);
  assert.match(role(COMMAND).systemPrompt, /owner/);
});
