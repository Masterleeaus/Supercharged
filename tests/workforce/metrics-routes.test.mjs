/**
 * Tests for server/workforce/runtime/metrics-routes.ts.
 * Stub auth guards stand in for the real auth middleware (the router takes guards as parameters).
 * The real requireCompanyScope runs, so company scope is exercised. Real express on an ephemeral port.
 * Run: node --test --experimental-transform-types tests/workforce/metrics-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWorkforceMetricsRouter, WORKFORCE_METRICS_PATH } from '../../server/workforce/runtime/metrics-routes.ts';
import { createWorkforceMetrics } from '../../server/workforce/runtime/workforce-metrics.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';

// Silence logging so the test runner's IPC stays clean.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-admin-a', role: 'admin', companyId: CO_A };
const ADMIN_NO_CO = { userId: 'u-admin-x', role: 'admin' };
const STAFF_A = { userId: 'u-staff-a', role: 'user', companyId: CO_A };

// Stub guards: the test identity arrives in the x-test-user header.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.userRole = u.role;
  req.user = { id: u.userId, role: u.role, ...(u.companyId ? { companyId: u.companyId } : {}) };
  next();
};
const stubRequireAdmin = (req, res, next) => (req.userRole === 'admin' ? next() : res.status(403).json({ error: 'Insufficient permissions' }));
const guards = { authenticate: stubAuthenticate, requireAdmin: stubRequireAdmin, requireCompanyScope: requireCompanyScope() };

function fixtureMetrics() {
  let t = Date.UTC(2026, 10, 4, 9, 0, 0);
  const m = createWorkforceMetrics({ now: () => t, thresholds: { maxFailureRatio: 0.5 } });
  // Company A: 2 started, 1 completed, 1 failed, 1 escalation, 1 refusal, 40 cents.
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_started', companyId: CO_A });
  m.record({ kind: 'run_completed', companyId: CO_A });
  m.record({ kind: 'run_failed', companyId: CO_A });
  m.record({ kind: 'escalation', companyId: CO_A });
  m.record({ kind: 'tool_refused', companyId: CO_A });
  m.record({ kind: 'spend', cents: 40, companyId: CO_A });
  // Company B: 1 started, 1 failed (its failure ratio alerts), 9 cents, many actions.
  m.record({ kind: 'run_started', companyId: CO_B });
  m.record({ kind: 'run_failed', companyId: CO_B });
  m.record({ kind: 'spend', cents: 9, companyId: CO_B });
  m.record({ kind: 'provider_error', provider: 'secret-provider' });
  return m;
}

async function start(deps, customGuards = guards) {
  const app = express();
  app.use(express.json());
  app.use(createWorkforceMetricsRouter(deps, customGuards));
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
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), text: null })),
  };
}

test('unauthenticated requests are refused', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, null);
    assert.equal(r.status, 401);
  } finally {
    await srv.close();
  }
});

test('non-admin users are refused', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, STAFF_A);
    assert.equal(r.status, 403);
    assert.equal(r.body.snapshot, undefined);
  } finally {
    await srv.close();
  }
});

test('an admin with no company scope is refused (fails closed)', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, ADMIN_NO_CO);
    assert.equal(r.status, 403);
    assert.equal(r.body.snapshot, undefined);
  } finally {
    await srv.close();
  }
});

test('an admin gets only their own company numbers and alerts', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, ADMIN_A);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.snapshot, {
      runsStarted: 2,
      runsCompleted: 1,
      completionRate: 0.5,
      runsFailed: 1,
      errorRate: 0.5,
      escalations: 1,
      toolCallsRefused: 1,
      toolRetries: 0,
      spendCents: 40,
      actions: 0,
    });
    assert.deepEqual(r.body.alerts.map((a) => a.code), ['failure_ratio_high']);
    assert.ok(!JSON.stringify(r.body).includes('secret-provider'));
    assert.ok(!JSON.stringify(r.body).includes(CO_B));
  } finally {
    await srv.close();
  }
});

test('a company id in the query or body is ignored; tenancy comes from the session only', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    const q = await srv.call('GET', `${WORKFORCE_METRICS_PATH}?companyId=${CO_B}`, ADMIN_A);
    assert.equal(q.status, 200);
    assert.equal(q.body.snapshot.runsStarted, 2);
    const b = await srv.call('GET', WORKFORCE_METRICS_PATH, ADMIN_A, { companyId: CO_B });
    assert.equal(b.body.snapshot.runsStarted, 2);
  } finally {
    await srv.close();
  }
});

test('the route is read-only: write methods are not routed', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await srv.call(method, WORKFORCE_METRICS_PATH, ADMIN_A, {});
      assert.ok(r.status >= 400, `${method} must not succeed, got ${r.status}`);
    }
  } finally {
    await srv.close();
  }
});

test('missing metrics configuration returns 503 and no numbers', async () => {
  const srv = await start({ getMetrics: () => null });
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, ADMIN_A);
    assert.equal(r.status, 503);
    assert.equal(r.body.snapshot, undefined);
  } finally {
    await srv.close();
  }
});

test('no getMetrics dependency at all returns 503', async () => {
  const srv = await start({});
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, ADMIN_A);
    assert.equal(r.status, 503);
  } finally {
    await srv.close();
  }
});

test('the agent breakdown is marked unavailable rather than invented', async () => {
  const srv = await start({ getMetrics: fixtureMetrics });
  try {
    const r = await srv.call('GET', WORKFORCE_METRICS_PATH, ADMIN_A);
    assert.deepEqual(r.body.agentBreakdown, { available: false, reason: 'agent_id_not_recorded' });
  } finally {
    await srv.close();
  }
});
