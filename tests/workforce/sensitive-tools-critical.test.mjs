import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep stdout clean for the test runner's IPC.
for (const fn of ['log', 'info', 'warn']) console[fn] = () => {};

// Checklist item: money movement, outbound customer sends and record deletion are only
// protected if every declaring role tags the tool 'critical'. Classification is by tool id
// tokens. A read verb makes a tool a read, so it is never classified. Fails closed: a missing
// toolRisk entry counts as not critical.

const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

const READ_VERBS = new Set(['list', 'get', 'check', 'view', 'status', 'read', 'search', 'lookup', 'availability']);
const MONEY = new Set(['payment', 'payments', 'payout', 'payouts', 'transfer', 'transfers', 'refund', 'refunds',
  'charge', 'charges', 'deposit', 'deposits', 'purchase']);
const OUTBOUND = new Set(['send', 'sends', 'sms', 'email', 'notify', 'reminder', 'reminders', 'survey', 'surveys',
  'campaign', 'campaigns', 'message', 'messages', 'request']);
const DELETION = new Set(['delete', 'deletes', 'remove', 'removes', 'purge', 'erase', 'destroy', 'merge', 'merges']);

/** Returns 'money', 'outbound', 'deletion' or null for a tool id. Drafts are not outbound sends. */
export function classifyTool(id) {
  const tokens = String(id).toLowerCase().split(/[._-]/);
  if (tokens.some((t) => READ_VERBS.has(t))) return null;
  if (tokens.some((t) => MONEY.has(t))) return 'money';
  if (tokens.some((t) => DELETION.has(t))) return 'deletion';
  if (!tokens.includes('draft') && tokens.some((t) => OUTBOUND.has(t))) return 'outbound';
  return null;
}

async function loadRoles() {
  const files = (await readdir(ROLES_DIR)).filter((f) => f.endsWith('.ts') && !f.startsWith('_')).sort();
  const roles = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(ROLES_DIR, file)).href);
    roles.push({ file, role: mod.role });
  }
  return roles;
}

test('classifier flags money, outbound sends and deletion, and not reads or drafts', () => {
  for (const id of [
    'payment_plans.propose', 'refund_requests.create', 'refund_requests.prepare', 'purchase_orders.draft',
    'supplier_payouts.transfer', 'card.charge', 'deposits.create',
    'customer_messages.send', 'messages.send_customer', 'campaign_messages.create', 'compliance_reminders.send',
    'feedback_surveys.send', 'reviews.request', 'job_signoff.request', 'job_photos.request_from_customer',
    'identity.verify_request', 'client_merge_suggestions.create', 'clients.delete', 'records.remove',
  ]) {
    assert.notEqual(classifyTool(id), null, `${id} must be classified`);
  }
  for (const id of [
    'payments.list', 'refund_requests.list', 'purchase_orders.list', 'supplier_bills.list', 'availability.read',
    'messages.draft_customer', 'customer_messages.draft', 'booking_requests.create', 'quote_requests.create',
    'clients.list', 'feedback_responses.create', 'escalations.create',
  ]) {
    assert.equal(classifyTool(id), null, `${id} must not be classified`);
  }
});

test('every declared money, outbound or deletion tool is tagged critical in each role that declares it', async () => {
  const roles = await loadRoles();
  assert.ok(roles.length > 100, `expected the full catalogue, found ${roles.length} roles`);

  const offenders = [];
  const seen = { money: new Set(), outbound: new Set(), deletion: new Set() };
  for (const { file, role } of roles) {
    for (const tool of role.tools ?? []) {
      const kind = classifyTool(tool);
      if (!kind) continue;
      seen[kind].add(tool);
      const risk = role.toolRisk?.[tool];
      if (risk !== 'critical') offenders.push(`${file}: ${tool} (${kind}) is ${risk ?? 'untagged'}, must be critical`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(seen.money.size > 0, 'no money-movement tool found, the classifier may have drifted');
  assert.ok(seen.outbound.size > 0, 'no outbound customer send found, the classifier may have drifted');
});
