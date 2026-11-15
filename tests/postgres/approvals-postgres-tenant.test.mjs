import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

// Disposable CI-only fixture. The tests are skipped unless both variables are set (see approvals-postgres-prepare.mjs).
const enabled = process.env.APPROVALS_PG_DISPOSABLE === 'true' && Boolean(process.env.APPROVALS_PG_INTEGRATION_URL);
const A = randomUUID();
const B = randomUUID();
const TTL = 60 * 60 * 1000;

let modules;
// Loads the real server modules only when the fixture is enabled. Importing them is not free of side effects:
// approval-service -> audit-log -> server/db.ts, which requires DATABASE_URL and opens a pool.
async function loadModules() {
  if (!modules) {
    // approval-service loads extensionless sibling modules and the '@shared' alias; register the test-only resolver.
    register(new URL('./support/extensionless-ts-hook.mjs', import.meta.url));
    if (!process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.APPROVALS_PG_INTEGRATION_URL;
    const { withTenant } = await import('../../server/infrastructure/database/tenant-context.ts');
    const { ApprovalService } = await import('../../server/modules/approvals/approval-service.ts');
    const { pool: appPool } = await import('../../server/db.ts');
    modules = { withTenant, ApprovalService, appPool };
    after(() => appPool.end());
  }
  return modules;
}

async function fixture() {
  const { withTenant, ApprovalService } = await loadModules();
  const pool = new pg.Pool({ connectionString: process.env.APPROVALS_PG_INTEGRATION_URL, max: 4 });
  // Same tenant runner shape as poolTenantRunner in server/modules/approvals/index.ts, bound to the test pool.
  const tenant = {
    run: (companyId, fn) => withTenant(pool, companyId, (client) => fn(drizzle(client))),
  };
  return { pool, service: new ApprovalService({ tenant }), close: () => pool.end() };
}

const rule = (name) => ({
  name, priority: 10, enabled: true, scope: 'global', agentIds: [], toolIds: [], rules: [],
});

test('PostgreSQL approvals: company B cannot read, list, decide or claim company A approvals', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const gate = await f.service.gateAction({
      companyId: A, requestedBy: 'user-a', agentId: 'agent-a', action: 'send_invoice',
      params: { amount: 10 }, ttlMs: TTL,
    });
    assert.equal(gate.status, 'pending');
    const id = gate.approval.id;

    assert.equal(await f.service.getApproval(B, id), null);
    const listB = await f.service.listApprovals(B, {});
    assert.equal(listB.some((a) => a.id === id), false);
    assert.equal(await f.service.decideApproval(B, id, 'approved', 'dashboard:user-b'), null);
    assert.equal(await f.service.markExecuted(B, id, 'user-b'), null);

    const stillA = await f.service.getApproval(A, id);
    assert.equal(stillA.status, 'pending');
    assert.ok((await f.service.listApprovals(A, {})).some((a) => a.id === id));

    const decided = await f.service.decideApproval(A, id, 'approved', 'dashboard:user-a');
    assert.equal(decided.status, 'approved');
  } finally {
    await f.close();
  }
});

test('PostgreSQL approvals: company B cannot read, edit or delete company A rules', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const created = await f.service.createRule(A, rule('tenant-rule-a'));
    assert.ok(created.id);

    const listB = await f.service.listRules(B);
    assert.equal(listB.some((r) => r.id === created.id), false);
    assert.equal(await f.service.updateRule(B, created.id, rule('hijacked')), null);
    assert.equal(await f.service.deleteRule(B, created.id), false);

    const still = (await f.service.listRules(A)).find((r) => r.id === created.id);
    assert.ok(still);
    assert.equal(still.name, 'tenant-rule-a');

    // The same rule name is allowed in another company (unique index is per company).
    const sameNameB = await f.service.createRule(B, rule('tenant-rule-a'));
    assert.notEqual(sameNameB.id, created.id);
  } finally {
    await f.close();
  }
});

test('PostgreSQL approvals: a call without a company is refused before any query runs', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.listApprovals('', {}), /companyId is required/);
  } finally {
    await f.close();
  }
});
