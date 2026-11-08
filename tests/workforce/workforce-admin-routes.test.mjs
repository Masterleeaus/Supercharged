/**
 * Tests for server/workforce/runtime/workforce-admin-routes.ts.
 * Stub auth guards stand in for the real auth middleware (which the router takes as parameters).
 * The real requireCompanyScope runs, so company scope is exercised. Real express on an ephemeral port.
 * Run: node --test --experimental-transform-types tests/workforce/workforce-admin-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWorkforceAdminRouter, REVIEW_INBOX_PATH } from '../../server/workforce/runtime/workforce-admin-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';
import { createControlState } from '../../server/workforce/runtime/controls.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-admin-a', role: 'admin', companyId: CO_A };
const ADMIN_B = { userId: 'u-admin-b', role: 'admin', companyId: CO_B };
const STAFF_A = { userId: 'u-staff-a', role: 'user', companyId: CO_A };
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Roster fake: which agent ids each company has on its roster. Pause and resume check this before any state change.
const ROSTER = {
  [CO_A]: new Set(['agent-1', 'a1', 'agent-9', 'shared-id']),
  [CO_B]: new Set(['shared-id']),
};
const isRosterAgent = (companyId, agentId) => ROSTER[companyId]?.has(agentId) === true;

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

async function start(deps, customGuards = guards) {
  const app = express();
  app.use(express.json());
  app.use(createWorkforceAdminRouter(deps, customGuards));
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

test('unauthenticated requests are refused on every route and nothing changes', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls, getApprovals: () => [], getRuns: () => [] });
  try {
    for (const [method, path] of [['GET', REVIEW_INBOX_PATH], ['POST', '/api/workforce/agents/a1/pause'], ['POST', '/api/workforce/agents/a1/resume']]) {
      const r = await srv.call(method, path, null, {});
      assert.equal(r.status, 401);
    }
    assert.equal(controls.state.agents.size, 0);
  } finally {
    await srv.close();
  }
});

test('non-admin users are refused on every route and nothing changes', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls, getApprovals: () => [], getRuns: () => [] });
  try {
    assert.equal((await srv.call('GET', REVIEW_INBOX_PATH, STAFF_A)).status, 403);
    assert.equal((await srv.call('POST', '/api/workforce/agents/a1/pause', STAFF_A)).status, 403);
    assert.equal((await srv.call('POST', '/api/workforce/agents/a1/resume', STAFF_A)).status, 403);
    assert.equal(controls.state.agents.size, 0);
  } finally {
    await srv.close();
  }
});

test('a user with no company scope is refused with 403', async () => {
  const srv = await start({ controls: { state: createControlState() }, getApprovals: () => [], getRuns: () => [] });
  try {
    const noCompany = { userId: 'u-admin-x', role: 'admin' };
    assert.equal((await srv.call('POST', '/api/workforce/agents/a1/pause', noCompany)).status, 403);
  } finally {
    await srv.close();
  }
});

test('pause then resume changes the agent state, and a second resume is refused with 409', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls, isRosterAgent });
  try {
    const paused = await srv.call('POST', '/api/workforce/agents/agent-1/pause', ADMIN_A);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, 'paused');
    assert.equal(paused.body.changed.by, 'human:u-admin-a');

    const resumed = await srv.call('POST', '/api/workforce/agents/agent-1/resume', ADMIN_A);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, 'active');

    const again = await srv.call('POST', '/api/workforce/agents/agent-1/resume', ADMIN_A);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'invalid_transition');
  } finally {
    await srv.close();
  }
});

test('another company with the same agent id is not affected by a pause', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls, isRosterAgent });
  try {
    assert.equal((await srv.call('POST', '/api/workforce/agents/shared-id/pause', ADMIN_A)).status, 200);
    // Company B's agent with the same id is still active, so B cannot resume it and can pause it independently.
    assert.equal((await srv.call('POST', '/api/workforce/agents/shared-id/resume', ADMIN_B)).status, 409);
    assert.equal((await srv.call('POST', '/api/workforce/agents/shared-id/pause', ADMIN_B)).status, 200);
    assert.equal((await srv.call('POST', '/api/workforce/agents/shared-id/resume', ADMIN_A)).status, 200);
    assert.equal(controls.state.agents.get(CO_B).get('shared-id').status, 'paused');
    assert.equal(controls.state.agents.get(CO_A).get('shared-id').status, 'active');
  } finally {
    await srv.close();
  }
});

test('company id in the body, query or header is ignored; the session company is used', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls, isRosterAgent });
  try {
    const r = await srv.call('POST', `/api/workforce/agents/agent-9/pause?companyId=${CO_B}`, { ...ADMIN_A }, { companyId: CO_B });
    assert.equal(r.status, 200);
    assert.equal(controls.state.agents.get(CO_A).get('agent-9').status, 'paused');
    assert.equal(controls.state.agents.get(CO_B), undefined);
  } finally {
    await srv.close();
  }
});

test('pause and resume of an agent not on the caller roster is 404 and changes no state', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls, isRosterAgent });
  try {
    // agent-b-only is not on company A's roster, so it is refused even though company A is the session company.
    const paused = await srv.call('POST', '/api/workforce/agents/agent-b-only/pause', ADMIN_A);
    assert.equal(paused.status, 404);
    assert.equal(paused.body.error, 'agent_not_found');
    const resumed = await srv.call('POST', '/api/workforce/agents/agent-b-only/resume', ADMIN_A);
    assert.equal(resumed.status, 404);
    assert.equal(controls.state.agents.size, 0);
  } finally {
    await srv.close();
  }
});

test('without an isRosterAgent dependency, pause and resume are refused (fail closed) and change no state', async () => {
  const controls = { state: createControlState() };
  const srv = await start({ controls });
  try {
    const paused = await srv.call('POST', '/api/workforce/agents/agent-1/pause', ADMIN_A);
    assert.equal(paused.status, 503);
    assert.equal(paused.body.dependency, 'isRosterAgent');
    assert.equal((await srv.call('POST', '/api/workforce/agents/agent-1/resume', ADMIN_A)).status, 503);
    assert.equal(controls.state.agents.size, 0);
  } finally {
    await srv.close();
  }
});

test('a missing dependency returns 503 instead of crashing', async () => {
  const srv = await start({ getApprovals: () => [], getRuns: () => [] });
  try {
    assert.equal((await srv.call('POST', '/api/workforce/agents/a1/pause', ADMIN_A)).status, 503);
    assert.equal((await srv.call('POST', '/api/workforce/agents/a1/resume', ADMIN_A)).status, 503);
  } finally {
    await srv.close();
  }
  const srv2 = await start({ controls: { state: createControlState() } });
  try {
    const r = await srv2.call('GET', REVIEW_INBOX_PATH, ADMIN_A);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'dependency_not_configured');
  } finally {
    await srv2.close();
  }
});

test('review inbox returns only the session company items', async () => {
  const approvals = [
    { id: 'ap-a', companyId: CO_A, agentId: 'agent-1', status: 'pending', createdAt: ago(10 * HOUR) },
    { id: 'ap-b', companyId: CO_B, agentId: 'agent-1', status: 'pending', createdAt: ago(10 * HOUR) },
  ];
  const runs = [
    { id: 'run-a', companyId: CO_A, agentId: 'agent-1', status: 'failed', createdAt: ago(2 * HOUR) },
    { id: 'run-b', companyId: CO_B, agentId: 'agent-1', status: 'failed', createdAt: ago(2 * HOUR) },
  ];
  const srv = await start({ controls: { state: createControlState() }, getApprovals: () => approvals, getRuns: () => runs });
  try {
    const r = await srv.call('GET', REVIEW_INBOX_PATH, ADMIN_A);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length > 0);
    assert.ok(r.body.items.every((item) => item.companyId === CO_A));
    const ids = r.body.items.map((item) => item.id).sort();
    assert.deepEqual(ids, ['approval_pending:ap-a', 'run_needs_attention:run-a']);
  } finally {
    await srv.close();
  }
});
