/**
 * Tests for server/workforce/runtime/company-controls-routes.ts.
 * Stub auth guards stand in for the real auth middleware. The real requireCompanyScope and the real
 * rate limiter run. Real express on an ephemeral port. Fakes for the store, audit sink and usage source.
 * The usage test uses the real budget ledger (budgets.ts). No database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/company-controls-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createCompanyControlsRouter,
  createMemoryControlsStore,
  createLedgerUsageSource,
  COMPANY_CONTROLS_PATH,
  WORKFORCE_USAGE_PATH,
} from '../../server/workforce/runtime/company-controls-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';
import { createBudgetLedger, reserve } from '../../server/workforce/runtime/budgets.ts';

// Silence the module's output. The test runner's IPC breaks on stray stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-admin-a', role: 'admin', companyId: CO_A };
const ADMIN_B = { userId: 'u-admin-b', role: 'admin', companyId: CO_B };
const STAFF_A = { userId: 'u-staff-a', role: 'user', companyId: CO_A };
const ADMIN_NO_COMPANY = { userId: 'u-admin-x', role: 'admin' };

const ROLES = [
  { id: 'estimator', name: 'Estimator', autonomy: 'suggest' },
  { id: 'dispatcher', name: 'Dispatcher', autonomy: 'auto' },
];

const BUDGETS = {
  maxToolCallsPerRun: 50,
  maxTokensPerRun: 200000,
  maxSpendCentsPerRun: 500,
  maxRunsPerCompanyPerDay: 100,
  maxSpendCentsPerCompanyPerDay: 10000,
};

function goodControls(overrides = {}) {
  return {
    roles: {
      estimator: { enabled: true, tier: 'suggest' },
      dispatcher: { enabled: true, tier: 'assist' },
    },
    policy: { requireApprovalFor: ['money', 'customer_send', 'delete'], deniedTools: [] },
    budgets: { ...BUDGETS },
    ...overrides,
  };
}

// Stub guards: the test identity arrives in the x-test-user header.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.userRole = u.role;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  next();
};
const stubRequireAdmin = (req, res, next) => (req.userRole === 'admin' ? next() : res.status(403).json({ error: 'Insufficient permissions' }));
const guards = { authenticate: stubAuthenticate, requireAdmin: stubRequireAdmin, requireCompanyScope: requireCompanyScope() };

function fakeAudit() {
  const entries = [];
  return { entries, record: (entry) => { entries.push(structuredClone(entry)); } };
}

async function start(deps, customGuards = guards) {
  const app = express();
  app.use(express.json());
  app.use(createCompanyControlsRouter(deps, customGuards));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
    call: (method, path, user, body) =>
      fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) },
        body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}

function fullDeps(overrides = {}) {
  const ledger = createBudgetLedger(BUDGETS);
  return {
    roles: () => ROLES,
    store: createMemoryControlsStore(),
    audit: fakeAudit(),
    usage: createLedgerUsageSource(ledger),
    now: () => Date.UTC(2026, 10, 4, 12, 0, 0),
    ...overrides,
    _ledger: ledger,
  };
}

// ---- access control -------------------------------------------------------------------------------

test('unauthenticated requests are refused on every route and nothing is stored', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    assert.equal((await srv.call('GET', COMPANY_CONTROLS_PATH, null)).status, 401);
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, null, { expectedVersion: 0, controls: goodControls() })).status, 401);
    assert.equal((await srv.call('GET', WORKFORCE_USAGE_PATH, null)).status, 401);
    assert.equal(await deps.store.read(CO_A), null);
    assert.equal(deps.audit.entries.length, 0);
  } finally {
    await srv.close();
  }
});

test('non-admin users are refused on every route and nothing is stored', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    assert.equal((await srv.call('GET', COMPANY_CONTROLS_PATH, STAFF_A)).status, 403);
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, STAFF_A, { expectedVersion: 0, controls: goodControls() })).status, 403);
    assert.equal((await srv.call('GET', WORKFORCE_USAGE_PATH, STAFF_A)).status, 403);
    assert.equal(await deps.store.read(CO_A), null);
    assert.equal(deps.audit.entries.length, 0);
  } finally {
    await srv.close();
  }
});

test('an admin with no company in the session is refused (fail closed)', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    assert.equal((await srv.call('GET', COMPANY_CONTROLS_PATH, ADMIN_NO_COMPANY)).status, 403);
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_NO_COMPANY, { expectedVersion: 0, controls: goodControls() })).status, 403);
    assert.equal(deps.audit.entries.length, 0);
  } finally {
    await srv.close();
  }
});

test('a write with no verified user id is refused, so only a human session can change controls', async () => {
  const deps = fullDeps();
  const noUserId = (req, res, next) => {
    const raw = req.headers['x-test-user'];
    if (!raw) return res.status(401).json({ error: 'Authentication required' });
    const u = JSON.parse(raw);
    req.userRole = u.role;
    req.user = { id: u.userId, role: u.role, companyId: u.companyId };
    next();
  };
  const srv = await start(deps, { ...guards, authenticate: noUserId });
  try {
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    assert.equal(r.status, 401);
    assert.equal(await deps.store.read(CO_A), null);
    assert.equal(deps.audit.entries.length, 0);
  } finally {
    await srv.close();
  }
});

test('the company comes from the session: a company id in the body is ignored and a company cannot touch another', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, companyId: CO_B, controls: goodControls() });
    assert.equal(r.status, 200);
    assert.equal(await deps.store.read(CO_B), null);
    assert.equal((await deps.store.read(CO_A)).version, 1);
    assert.equal(deps.audit.entries[0].metadata.companyId, CO_A);

    const other = await srv.call('GET', COMPANY_CONTROLS_PATH, ADMIN_B);
    assert.equal(other.body.configured, false);
    assert.equal(other.body.version, 0);
  } finally {
    await srv.close();
  }
});

// ---- reading controls -----------------------------------------------------------------------------

test('GET returns safe defaults when nothing is saved: every role disabled at the lowest tier, no budgets', async () => {
  const srv = await start(fullDeps());
  try {
    const r = await srv.call('GET', COMPANY_CONTROLS_PATH, ADMIN_A);
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, false);
    assert.equal(r.body.version, 0);
    assert.deepEqual(r.body.roles, [
      { id: 'estimator', name: 'Estimator', cap: 'suggest' },
      { id: 'dispatcher', name: 'Dispatcher', cap: 'auto' },
    ]);
    for (const role of Object.values(r.body.controls.roles)) assert.deepEqual(role, { enabled: false, tier: 'assist' });
    assert.equal(r.body.controls.budgets, null);
  } finally {
    await srv.close();
  }
});

// ---- writing controls -----------------------------------------------------------------------------

test('a valid PUT stores the document as version 1, records one audit entry and returns the changes', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    assert.equal(r.status, 200);
    assert.equal(r.body.version, 1);
    assert.equal(r.body.changed, true);
    assert.ok(r.body.changes.includes('role estimator: disabled -> enabled'));

    const stored = await deps.store.read(CO_A);
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.controls.budgets, BUDGETS);

    assert.equal(deps.audit.entries.length, 1);
    const entry = deps.audit.entries[0];
    assert.equal(entry.action, 'admin.settings_update');
    assert.equal(entry.userId, 'u-admin-a');
    assert.equal(entry.resourceType, 'company_controls');
    assert.equal(entry.resourceId, CO_A);
    assert.equal(entry.metadata.fromVersion, 0);
    assert.equal(entry.metadata.toVersion, 1);
  } finally {
    await srv.close();
  }
});

test('a PUT with a stale expectedVersion gets 409 and stores nothing new', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    const stale = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls({ budgets: { ...BUDGETS, maxRunsPerCompanyPerDay: 5 } }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.version, 1);
    assert.equal((await deps.store.read(CO_A)).controls.budgets.maxRunsPerCompanyPerDay, 100);
    assert.equal(deps.audit.entries.length, 1);
  } finally {
    await srv.close();
  }
});

test('a tier above the role cap is refused with 400 and nothing is stored or audited', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    const controls = goodControls();
    controls.roles.estimator.tier = 'auto';
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_controls');
    assert.match(r.body.reason, /roles\.estimator\.tier/);
    assert.equal(await deps.store.read(CO_A), null);
    assert.equal(deps.audit.entries.length, 0);
  } finally {
    await srv.close();
  }
});

test('turning off an owner approval rule is refused with 400 and nothing is stored', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    for (const rule of ['money', 'customer_send', 'delete']) {
      const controls = goodControls();
      controls.policy.requireApprovalFor = ['money', 'customer_send', 'delete'].filter((r) => r !== rule);
      const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls });
      assert.equal(r.status, 400, `removing ${rule} must be refused`);
      assert.match(r.body.reason, new RegExp(`owner rule '${rule}'`));
    }
    assert.equal(await deps.store.read(CO_A), null);
    assert.equal(deps.audit.entries.length, 0);
  } finally {
    await srv.close();
  }
});

test('a budget that is zero, negative or missing is refused with 400', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    const zero = goodControls();
    zero.budgets.maxToolCallsPerRun = 0;
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: zero })).status, 400);

    const negative = goodControls();
    negative.budgets.maxSpendCentsPerRun = -5;
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: negative })).status, 400);

    const missing = goodControls();
    delete missing.budgets;
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: missing })).status, 400);

    assert.equal(await deps.store.read(CO_A), null);
  } finally {
    await srv.close();
  }
});

test('a role missing from the document, or an unknown role, is refused with 400', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    const missing = goodControls();
    delete missing.roles.dispatcher;
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: missing })).status, 400);

    const unknown = goodControls();
    unknown.roles.ghost = { enabled: true, tier: 'assist' };
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: unknown });
    assert.equal(r.status, 400);
    assert.equal(r.body.reason.includes('ghost'), false);

    assert.equal(await deps.store.read(CO_A), null);
  } finally {
    await srv.close();
  }
});

test('a bad expectedVersion is refused with 400', async () => {
  const srv = await start(fullDeps());
  try {
    for (const expectedVersion of [-1, 1.5, '0', null, undefined]) {
      const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion, controls: goodControls() });
      assert.equal(r.status, 400, `expectedVersion ${String(expectedVersion)} must be refused`);
    }
  } finally {
    await srv.close();
  }
});

test('if the audit sink fails, the change is not stored (audit before write)', async () => {
  const deps = fullDeps({ audit: { record: () => { throw new Error('audit down'); } } });
  const srv = await start(deps);
  try {
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    assert.equal(r.status, 503);
    assert.equal(r.body.dependency, 'audit');
    assert.equal(await deps.store.read(CO_A), null);
  } finally {
    await srv.close();
  }
});

test('a PUT that changes nothing returns changed false and writes no audit entry', async () => {
  const deps = fullDeps();
  const srv = await start(deps);
  try {
    await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    const same = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 1, controls: goodControls() });
    assert.equal(same.status, 200);
    assert.equal(same.body.changed, false);
    assert.equal(same.body.version, 1);
    assert.equal(deps.audit.entries.length, 1);
  } finally {
    await srv.close();
  }
});

test('refusal reasons never echo a submitted value that is not a field name', async () => {
  const srv = await start(fullDeps());
  try {
    const controls = goodControls();
    controls.roles.estimator.tier = 'SECRET-VALUE-123';
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls });
    assert.equal(r.status, 400);
    assert.equal(JSON.stringify(r.body).includes('SECRET-VALUE-123'), false);
  } finally {
    await srv.close();
  }
});

// ---- fail closed on missing dependencies ----------------------------------------------------------

test('a missing store, roles, audit or usage source returns 503 and changes nothing', async () => {
  const cases = [
    [{ roles: () => ROLES, audit: fakeAudit() }, 'store'],
    [{ store: createMemoryControlsStore(), audit: fakeAudit() }, 'roles'],
  ];
  for (const [deps, name] of cases) {
    const srv = await start(deps);
    try {
      const get = await srv.call('GET', COMPANY_CONTROLS_PATH, ADMIN_A);
      assert.equal(get.status, 503);
      assert.equal(get.body.error, 'dependency_not_configured');
      const put = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
      assert.equal(put.status, 503);
      assert.ok([name, 'roles', 'store'].includes(put.body.dependency));
    } finally {
      await srv.close();
    }
  }

  const noAudit = fullDeps({ audit: undefined });
  const srv = await start(noAudit);
  try {
    const r = await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    assert.equal(r.status, 503);
    assert.equal(r.body.dependency, 'audit');
    assert.equal(await noAudit.store.read(CO_A), null);
  } finally {
    await srv.close();
  }

  const noUsage = fullDeps({ usage: undefined });
  const srvUsage = await start(noUsage);
  try {
    const r = await srvUsage.call('GET', WORKFORCE_USAGE_PATH, ADMIN_A);
    assert.equal(r.status, 503);
    assert.equal(r.body.dependency, 'usage');
  } finally {
    await srvUsage.close();
  }
});

test('an invalid role catalogue (unknown tier) returns 503 and stores nothing', async () => {
  const deps = fullDeps({ roles: () => [{ id: 'estimator', name: 'Estimator', autonomy: 'observe_only' }] });
  const srv = await start(deps);
  try {
    assert.equal((await srv.call('GET', COMPANY_CONTROLS_PATH, ADMIN_A)).status, 503);
    assert.equal((await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() })).status, 503);
    assert.equal(await deps.store.read(CO_A), null);
  } finally {
    await srv.close();
  }
});

// ---- usage ----------------------------------------------------------------------------------------

test('usage reports spend and tool calls for this company only, from the budget ledger', async () => {
  const deps = fullDeps();
  const now = deps.now();
  // Company A: two runs. Company B: one run with large numbers that must not appear for A.
  reserve(deps._ledger, { companyId: CO_A, runId: 'run-a1', toolCalls: 3, tokens: 100, spendCents: 40, now });
  reserve(deps._ledger, { companyId: CO_A, runId: 'run-a2', toolCalls: 2, tokens: 50, spendCents: 10, now });
  reserve(deps._ledger, { companyId: CO_B, runId: 'run-b1', toolCalls: 30, tokens: 900, spendCents: 400, now });

  const srv = await start(deps);
  try {
    await srv.call('PUT', COMPANY_CONTROLS_PATH, ADMIN_A, { expectedVersion: 0, controls: goodControls() });
    const r = await srv.call('GET', WORKFORCE_USAGE_PATH, ADMIN_A);
    assert.equal(r.status, 200);
    assert.equal(r.body.day, '2026-11-04');
    assert.deepEqual(r.body.totals, { runs: 2, toolCalls: 5, tokens: 150, spendCents: 50 });
    assert.deepEqual(r.body.today, { runsStarted: 2, spendCents: 50 });
    assert.deepEqual(r.body.budgets, BUDGETS);
    assert.deepEqual(r.body.remainingToday, { runs: 98, spendCents: 9950 });

    const b = await srv.call('GET', WORKFORCE_USAGE_PATH, ADMIN_B);
    assert.deepEqual(b.body.totals, { runs: 1, toolCalls: 30, tokens: 900, spendCents: 400 });
    assert.equal(b.body.budgets, null);
    assert.equal(b.body.remainingToday, null);
  } finally {
    await srv.close();
  }
});

test('usage today figures reset on a new UTC day, while totals keep the earlier runs', async () => {
  const deps = fullDeps();
  reserve(deps._ledger, { companyId: CO_A, runId: 'run-old', toolCalls: 4, tokens: 10, spendCents: 25, now: Date.UTC(2026, 10, 3, 23, 0, 0) });
  const srv = await start(deps);
  try {
    const r = await srv.call('GET', WORKFORCE_USAGE_PATH, ADMIN_A);
    assert.deepEqual(r.body.today, { runsStarted: 0, spendCents: 0 });
    assert.deepEqual(r.body.totals, { runs: 1, toolCalls: 4, tokens: 10, spendCents: 25 });
  } finally {
    await srv.close();
  }
});
