/**
 * Tests for the agent create, configure and retire routes in server/workforce/runtime/workforce-admin-routes.ts.
 * The roster is the in-memory roster behind its port adapter. Control state is the real controls.ts holder.
 * Stub auth guards stand in for the real middleware; the real requireCompanyScope runs.
 * Run: node --test --experimental-transform-types tests/workforce/workforce-agent-admin-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Keep the test runner's stdout clean: server modules may log during import or in handlers.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const express = (await import('express')).default;
const { createWorkforceAdminRouter, AGENTS_PATH } = await import('../../server/workforce/runtime/workforce-admin-routes.ts');
const { requireCompanyScope } = await import('../../server/middleware/company-scope.ts');
const controls = await import('../../server/workforce/runtime/controls.ts');
const loader = await import('../../server/workforce/catalogue/loader.ts');
const roster = await import('../../server/workforce/roster.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const catalogue = await loader.loadRoleCatalogue(rolesDir);

// Real roles. appointment-reminder: autonomy auto. compliance-expiry-tracker: autonomy suggest, channel email only.
const AUTO_ROLE = 'appointment-reminder';
const SUGGEST_ROLE = 'compliance-expiry-tracker';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-admin-a', role: 'admin', companyId: CO_A };
const MANAGER_A = { userId: 'u-manager-a', role: 'manager', companyId: CO_A };
const ADMIN_B = { userId: 'u-admin-b', role: 'admin', companyId: CO_B };
const MANAGER_B = { userId: 'u-manager-b', role: 'manager', companyId: CO_B };
const STAFF_A = { userId: 'u-staff-a', role: 'user', companyId: CO_A };

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
const stubRequireManager = (req, res, next) =>
  req.userRole === 'admin' || req.userRole === 'manager' ? next() : res.status(403).json({ error: 'Insufficient permissions' });

const guards = {
  authenticate: stubAuthenticate,
  requireAdmin: stubRequireAdmin,
  requireManager: stubRequireManager,
  requireCompanyScope: requireCompanyScope(),
};

function newFixture({ withRoster = true, withControls = true } = {}) {
  const rosterInstance = roster.createRoster(catalogue);
  const holder = { state: controls.createControlState() };
  const deps = {
    getApprovals: () => [],
    getRuns: () => [],
  };
  if (withControls) deps.controls = holder;
  if (withRoster) deps.roster = roster.createRosterPort(rosterInstance);
  // Pause and resume check the caller's roster. Retired agents stay on the roster, so the retired check still applies.
  deps.isRosterAgent = (companyId, agentId) => roster.getAgent(rosterInstance, companyId, agentId) !== undefined;
  return { rosterInstance, holder, deps };
}

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
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}

function createBody(overrides = {}) {
  return {
    agentId: 'agent-1',
    roleId: AUTO_ROLE,
    teamId: 'team-north',
    channels: ['sms'],
    permissions: ['booking_requests.list'],
    autonomy: 'auto',
    ...overrides,
  };
}

async function withServer(fixture, fn, customGuards) {
  const srv = await start(fixture.deps, customGuards);
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

test('unauthenticated create, configure and retire are refused with 401 and nothing changes', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    assert.equal((await srv.call('POST', AGENTS_PATH, null, createBody())).status, 401);
    assert.equal((await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, null, { autonomy: 'assist' })).status, 401);
    assert.equal((await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, null, {})).status, 401);
  });
  assert.deepEqual(f.rosterInstance.companies.size, 0);
  assert.equal(f.holder.state.agents.size, 0);
});

test('staff users without a manager or admin role are refused with 403 on every write and nothing changes', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    assert.equal((await srv.call('POST', AGENTS_PATH, STAFF_A, createBody())).status, 403);
    assert.equal((await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, STAFF_A, { autonomy: 'assist' })).status, 403);
    assert.equal((await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, STAFF_A, {})).status, 403);
  });
  assert.equal(f.rosterInstance.companies.size, 0);
});

test('a manager and an admin can create an agent from a catalogue role, active, in the session company', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const managerCreate = await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());
    assert.equal(managerCreate.status, 201);
    assert.equal(managerCreate.body.agent.companyId, CO_A);
    assert.equal(managerCreate.body.agent.roleId, AUTO_ROLE);
    assert.equal(managerCreate.body.agent.status, 'active');

    const adminCreate = await srv.call('POST', AGENTS_PATH, ADMIN_A, createBody({ agentId: 'agent-2' }));
    assert.equal(adminCreate.status, 201);
  });
  assert.deepEqual(roster.listAgents(f.rosterInstance, CO_A).map((a) => a.agentId).sort(), ['agent-1', 'agent-2']);
});

test('a companyId in the body is ignored: the agent is created in the session company only', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const r = await srv.call('POST', `${AGENTS_PATH}?companyId=${CO_B}`, MANAGER_A, createBody({ companyId: CO_B }));
    assert.equal(r.status, 201);
    assert.equal(r.body.agent.companyId, CO_A);
  });
  assert.deepEqual(roster.listAgents(f.rosterInstance, CO_B), []);
  assert.equal(roster.listAgents(f.rosterInstance, CO_A).length, 1);
});

test('an unknown role is refused with 400 and no agent is created', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const r = await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody({ roleId: 'no-such-role' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'unknown_role');
  });
  assert.deepEqual(roster.listAgents(f.rosterInstance, CO_A), []);
});

test('create refuses an autonomy above the role tier cap with 409', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const above = await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody({ autonomy: 'predictive' }));
    assert.equal(above.status, 409);
    assert.equal(above.body.error, 'autonomy_exceeds_role');

    const suggestRoleAuto = await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody({
      agentId: 'agent-s', roleId: SUGGEST_ROLE, channels: ['email'], permissions: [], autonomy: 'auto',
    }));
    assert.equal(suggestRoleAuto.status, 409);
    assert.equal(suggestRoleAuto.body.error, 'autonomy_exceeds_role');

    const atCap = await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody({ agentId: 'agent-s2', roleId: SUGGEST_ROLE, channels: ['email'], permissions: [], autonomy: 'suggest' }));
    assert.equal(atCap.status, 201);
  });
});

test('an omitted autonomy defaults to assist, the most restrictive tier', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const body = createBody();
    delete body.autonomy;
    const r = await srv.call('POST', AGENTS_PATH, MANAGER_A, body);
    assert.equal(r.status, 201);
    assert.equal(r.body.agent.autonomy, 'assist');
  });
});

test('a non-object body is refused with 400 invalid_input', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const r = await srv.call('POST', AGENTS_PATH, MANAGER_A, ['not', 'an', 'object']);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_input');
  });
});

test('configure applies a valid patch, refuses a tier above the cap, and refuses fixed or unknown fields', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());

    const ok = await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, MANAGER_A, { autonomy: 'assist', teamId: 'team-south' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.agent.autonomy, 'assist');
    assert.equal(ok.body.agent.teamId, 'team-south');

    const above = await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, MANAGER_A, { autonomy: 'predictive' });
    assert.equal(above.status, 409);
    assert.equal(above.body.error, 'autonomy_exceeds_role');

    const fixed = await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, MANAGER_A, { companyId: CO_B });
    assert.equal(fixed.status, 400);
    assert.equal(fixed.body.error, 'immutable_field');

    const unknown = await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, MANAGER_A, { status: 'active' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, 'invalid_input');

    const missing = await srv.call('PATCH', `${AGENTS_PATH}/no-such-agent`, MANAGER_A, { autonomy: 'assist' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'agent_not_found');
  });
  assert.equal(roster.getAgent(f.rosterInstance, CO_A, 'agent-1').autonomy, 'assist');
});

test('retire a paused agent: the work gate closes at once, the roster records retired, and nothing reopens it', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());
    assert.equal((await srv.call('POST', '/api/workforce/agents/agent-1/pause', ADMIN_A)).status, 200);

    const retired = await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, MANAGER_A, {});
    assert.equal(retired.status, 200);
    assert.equal(retired.body.status, 'retired');
    assert.equal(retired.body.changed.by, 'human:u-manager-a');

    assert.deepEqual(controls.canStartWork(f.holder.state, CO_A, 'agent-1'), { allowed: false, reason: 'agent_retired' });
    assert.equal(roster.getAgent(f.rosterInstance, CO_A, 'agent-1').status, 'retired');

    assert.equal((await srv.call('POST', '/api/workforce/agents/agent-1/resume', ADMIN_A)).status, 409);
    assert.equal((await srv.call('POST', '/api/workforce/agents/agent-1/pause', ADMIN_A)).status, 409);
    const configure = await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, MANAGER_A, { autonomy: 'assist' });
    assert.equal(configure.status, 409);
    assert.equal(configure.body.error, 'agent_retired');
    const again = await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, MANAGER_A, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'agent_retired');
  });
});

test('retire of an unknown agent is 404 and changes no control state', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    const r = await srv.call('POST', `${AGENTS_PATH}/no-such-agent/retire`, ADMIN_A, {});
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'agent_not_found');
  });
  assert.equal(f.holder.state.agents.size, 0);
});

test('retire is company scoped: another company cannot retire an agent, and the owner keeps it active', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());
    const other = await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, ADMIN_B, {});
    assert.equal(other.status, 404);
    assert.equal(other.body.error, 'agent_not_found');
    assert.equal((await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, MANAGER_B, {})).status, 404);
  });
  assert.equal(roster.getAgent(f.rosterInstance, CO_A, 'agent-1').status, 'active');
  assert.deepEqual(controls.canStartWork(f.holder.state, CO_A, 'agent-1'), { allowed: true });
});

test('a resume is refused when the roster records the agent as retired, even if controls do not know it', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());
    // Simulates a roster retirement that the control holder never saw, such as a restart without seeding.
    await f.deps.roster.setAgentStatus(CO_A, 'agent-1', 'retired');

    const resume = await srv.call('POST', '/api/workforce/agents/agent-1/resume', ADMIN_A);
    assert.equal(resume.status, 409);
    assert.equal(resume.body.error, 'agent_retired');
  });
  assert.equal(f.holder.state.agents.size, 0, 'the refused resume changes no control state');
});

test('a retry after controls already retired the agent completes the roster write', async () => {
  const f = newFixture();
  await withServer(f, async (srv) => {
    await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());
    // Controls retired the agent, but the roster write did not happen (for example it failed).
    f.holder.state = controls.retireAgent(f.holder.state, CO_A, 'agent-1', { kind: 'human', userId: 'u-admin-a' }).state;

    const retry = await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, MANAGER_A, {});
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, 'retired');
  });
  assert.equal(roster.getAgent(f.rosterInstance, CO_A, 'agent-1').status, 'retired');
});

test('the agent write routes refuse with 503 when the roster or the controls are not configured', async () => {
  const noRoster = newFixture({ withRoster: false });
  await withServer(noRoster, async (srv) => {
    assert.equal((await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody())).status, 503);
    assert.equal((await srv.call('PATCH', `${AGENTS_PATH}/agent-1`, MANAGER_A, { autonomy: 'assist' })).status, 503);
    assert.equal((await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, MANAGER_A, {})).status, 503);
  });

  const noControls = newFixture({ withControls: false });
  await withServer(noControls, async (srv) => {
    await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody());
    const r = await srv.call('POST', `${AGENTS_PATH}/agent-1/retire`, MANAGER_A, {});
    assert.equal(r.status, 503);
    assert.equal(r.body.dependency, 'controls');
  });
  assert.equal(roster.getAgent(noControls.rosterInstance, CO_A, 'agent-1').status, 'active');
});

test('without a manager guard the write routes fall back to admin only, so a manager is refused', async () => {
  const f = newFixture();
  const { requireManager: _omitted, ...narrowGuards } = guards;
  await withServer(f, async (srv) => {
    assert.equal((await srv.call('POST', AGENTS_PATH, MANAGER_A, createBody())).status, 403);
    assert.equal((await srv.call('POST', AGENTS_PATH, ADMIN_A, createBody())).status, 201);
  }, narrowGuards);
});
