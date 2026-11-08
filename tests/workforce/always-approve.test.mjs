import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Static check, no network and no database. Role files are loaded the same way
// as roles-trades.test.mjs: a dynamic import of each file in the roles folder.
const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);

// Owner rule (decided): under Auto, money movement (payments, refunds, charges,
// payouts), outbound messages to customers, and record deletes or merges always
// need owner approval. The approvals ladder holds any critical-risk action, so
// every such tool must be declared with toolRisk "critical" by each role using it.
const RISKY =
  /refund|payment|charge|payout|pay\b|invoice\.send|\.send$|send_customer|request_from_customer|\.request$|delete|merge|remove|purge/;

// Tool IDs that match RISKY but are not sends or money movement. Each entry needs a reason.
// Draft tools such as customer_messages.draft and messages.draft_customer do not match
// RISKY at all, so they need no entry here; they are drafts for a person to review.
const ALLOW = new Map([
  // Read-only list of payment records. Lists money already received; it moves nothing.
  ['payments.list', 'read-only list of payments; no money movement'],
  // Read-only list of refund requests. Lists existing requests; issues no refund.
  ['refund_requests.list', 'read-only list of refund requests; issues no refund'],
]);

// Tools the owner rule is known to cover. The pattern must find them, or the roles have drifted.
const KNOWN = ['customer_messages.send', 'refund_requests.create', 'client_merge_suggestions.create'];

// Load every real role file. Files starting with "_" (such as _example.ts) are templates, not roles.
const files = readdirSync(rolesDir)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .sort();

const roles = [];
for (const file of files) {
  const mod = await import(new URL(file, rolesDir).href);
  roles.push(mod.role);
}

// Map each declared tool ID to the roles that declare it, with that role's toolRisk for it.
const declared = new Map();
for (const role of roles) {
  for (const tool of role.tools) {
    if (!declared.has(tool)) declared.set(tool, []);
    declared.get(tool).push({ roleId: role.id, risk: role.toolRisk[tool] });
  }
}

const matched = [...declared.keys()].filter((tool) => RISKY.test(tool) && !ALLOW.has(tool)).sort();

test('the roles folder yields role files to check', () => {
  assert.ok(roles.length > 0, 'no role files found');
  assert.ok(declared.size > 0, 'no tool IDs found in any role');
});

test('every money, customer-send and delete/merge tool is critical in every role that declares it', () => {
  const offenders = [];
  for (const tool of matched) {
    for (const { roleId, risk } of declared.get(tool)) {
      if (risk !== 'critical') offenders.push(`${roleId}:${tool} is ${risk ?? 'undeclared'}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `non-critical gated tools:\n  ${offenders.join('\n  ')}\nmatched tool IDs: ${matched.join(', ')}`,
  );
});

test('the pattern finds the known owner-rule tools in the roles', () => {
  for (const tool of KNOWN) {
    assert.ok(RISKY.test(tool), `${tool} no longer matches the RISKY pattern`);
    assert.ok(
      declared.has(tool),
      `${tool} is missing from the roles; matched tool IDs: ${matched.join(', ')}`,
    );
  }
});

test('allow list entries are real, match the pattern, and are not sends', () => {
  for (const [tool, reason] of ALLOW) {
    assert.ok(reason && reason.length > 0, `${tool} needs a reason`);
    assert.ok(RISKY.test(tool), `${tool} is on the allow list but does not match the pattern`);
    assert.ok(declared.has(tool), `${tool} is on the allow list but no role declares it`);
    assert.doesNotMatch(tool, /send|request_from_customer|propose|create/, `${tool} looks like a send; remove it from the allow list`);
  }
});
