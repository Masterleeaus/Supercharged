/**
 * Tests for server/routes/workforce-roster-routes.ts.
 * Stub auth guards stand in for the real authenticate middleware. The real requireCompanyScope runs,
 * and the role guard is a stub that allows admin and manager only, as requireRole('admin', 'manager') does.
 * The agents come from a real roster built from the real role catalogue, through listAgents.
 * Real express on an ephemeral port.
 * Run: node --test --experimental-transform-types tests/routes/workforce-roster-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Same zod fallback as tests/workforce/roster.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const { createWorkforceRosterRouter, WORKFORCE_AGENTS_PATH } = await import('../../server/routes/workforce-roster-routes.ts');
const { requireCompanyScope } = await import('../../server/middleware/company-scope.ts');
const loader = await import('../../server/workforce/catalogue/loader.ts');
const roster = await import('../../server/workforce/roster.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const catalogue = await loader.loadRoleCatalogue(rolesDir);

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-a', role: 'admin', companyId: CO_A };
const MANAGER_A = { userId: 'u-m', role: 'manager', companyId: CO_A };
const MEMBER_A = { userId: 'u-mem', role: 'member', companyId: CO_A };
const USER_NO_COMPANY = { userId: 'u-x', role: 'admin' };

// Stub authenticate: the test identity arrives in the x-test-user header. No header means refused.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  next();
};
const stubRequireApprover = (req, res, next) => {
  if (req.user && ['admin', 'manager'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};
const guards = {
  authenticate: stubAuthenticate,
  requireCompanyScope: requireCompanyScope(),
  requireApprover: stubRequireApprover,
};

/** Builds a real roster with agents in two companies. */
function buildRoster() {
  const r = roster.createRoster(catalogue);
  const add = (companyId, agentId, roleId, extra = {}) => {
    const result = roster.createAgent(r, {
      companyId,
      roleId,
      agentId,
      channels: [roleId === 'appointment-reminder' ? 'sms' : 'email'],
      autonomy: 'assist',
      ...extra,
    });
    assert.equal(result.ok, true, `setup failed for ${agentId}: ${result.message ?? ''}`);
  };
  add(CO_A, 'agent-a-1', 'appointment-reminder');
  add(CO_A, 'agent-a-2', 'compliance-expiry-tracker');
  add(CO_B, 'agent-b-1', 'appointment-reminder');
  return r;
}

async function start(deps) {
  const app = express();
  app.use(express.json());
  app.use(createWorkforceRosterRouter(deps, guards));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
    call: (method, path, user) =>
      fetch(base + path, {
        method,
        headers: user ? { 'x-test-user': JSON.stringify(user) } : {},
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}

test('unauthenticated requests are refused and the roster is not read', async () => {
  let reads = 0;
  const srv = await start({ listAgents: () => { reads += 1; return []; } });
  try {
    const res = await srv.call('GET', WORKFORCE_AGENTS_PATH, null);
    assert.equal(res.status, 401);
    assert.equal(reads, 0);
  } finally {
    await srv.close();
  }
});

test('a plain member is refused with 403 and the roster is not read', async () => {
  let reads = 0;
  const srv = await start({ listAgents: () => { reads += 1; return []; } });
  try {
    const res = await srv.call('GET', WORKFORCE_AGENTS_PATH, MEMBER_A);
    assert.equal(res.status, 403);
    assert.equal(reads, 0);
    assert.equal(res.body.items, undefined);
  } finally {
    await srv.close();
  }
});

test('a user with no company is refused with 403', async () => {
  const srv = await start({ listAgents: () => [] });
  try {
    const res = await srv.call('GET', WORKFORCE_AGENTS_PATH, USER_NO_COMPANY);
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('an admin and a manager get only their own company agents, as id, roleId, status and name', async () => {
  const r = buildRoster();
  const srv = await start({ listAgents: (companyId) => roster.listAgents(r, companyId) });
  try {
    for (const user of [ADMIN_A, MANAGER_A]) {
      const res = await srv.call('GET', WORKFORCE_AGENTS_PATH, user);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items.map((item) => item.id).sort(), ['agent-a-1', 'agent-a-2']);
      for (const item of res.body.items) {
        assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'roleId', 'status']);
        assert.equal(item.status, 'active');
      }
      assert.ok(!JSON.stringify(res.body).includes('agent-b-1'));
    }
  } finally {
    await srv.close();
  }
});

test('a company id sent in the query or body does not change the company that is read', async () => {
  const r = buildRoster();
  const seen = [];
  const srv = await start({
    listAgents: (companyId) => {
      seen.push(companyId);
      return roster.listAgents(r, companyId);
    },
  });
  try {
    const res = await srv.call('GET', `${WORKFORCE_AGENTS_PATH}?companyId=${CO_B}`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [CO_A]);
    assert.ok(!JSON.stringify(res.body).includes('agent-b-1'));
  } finally {
    await srv.close();
  }
});

test('a company with no agents gets an empty list', async () => {
  const r = buildRoster();
  const srv = await start({ listAgents: (companyId) => roster.listAgents(r, companyId) });
  try {
    const other = { userId: 'u-c', role: 'admin', companyId: '33333333-3333-4333-8333-333333333333' };
    const res = await srv.call('GET', WORKFORCE_AGENTS_PATH, other);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [] });
  } finally {
    await srv.close();
  }
});
