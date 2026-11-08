/**
 * Auth, role and tenant checks for every workforce agent, roster, task, approval, control and usage route
 * mounted by the factories in server/workforce/runtime/*-routes.ts.
 *
 * Factories covered (and the routes each one serves):
 *   createWorkforceAdminRouter    review inbox, pause, resume, agent create, agent configure, agent retire
 *   createTaskBoardRouter         tasks, run history
 *   createCompanyControlsRouter   company controls read and write, usage
 *   createWorkforceMetricsRouter  metrics
 *   createShadowRouter            approval list, approve, reject, retry (already in route-permissions.test.mjs)
 *   createWorkforceRosterRouter   roster list (lives in server/routes/, already in route-permissions.test.mjs)
 *
 * Every guard is a recording stub. authenticate sets req.user and req.userId from a test header. requireRole is the
 * same rule as server/middleware/auth.ts (admin always passes, otherwise the role must be listed). The company guard
 * is the real requireCompanyScope(), wrapped so each call is recorded. Dependencies record the company they receive.
 *
 * For every route, the checks are:
 *   - no identity: 401, the guard chain stops at authenticate, and no dependency runs
 *   - member: 403 at the role guard, and no dependency runs
 *   - no company on the session, or a company that is not a UUID: 403 at the scope guard, and no dependency runs
 *   - the allowed roles get their success status, and a role that is not allowed is refused by the role guard
 *   - the guard order is authenticate, then role, then company scope
 *   - a company sent in query, body or header is ignored: every dependency receives the session company only
 *
 * Route specific checks: a manager cannot pause or resume; an agent on another company cannot be configured or
 * retired; a missing role guard for manager routes falls back to admin only; a missing dependency returns 503.
 *
 * Not covered: live requests against the mounted app (checklist section 12 still open), the inline routes in
 * server/routes.ts, and provider traffic. Nothing here opens a network connection to a provider.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/security/workforce-route-auth.test.mjs
 */
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  createWorkforceAdminRouter,
  REVIEW_INBOX_PATH,
  AGENTS_PATH,
  AGENT_PATH,
  AGENT_PAUSE_PATH,
  AGENT_RESUME_PATH,
  AGENT_RETIRE_PATH,
} from '../../server/workforce/runtime/workforce-admin-routes.ts';
import { createTaskBoardRouter, TASKS_PATH, RUN_HISTORY_PATH } from '../../server/workforce/runtime/task-board-routes.ts';
import {
  createCompanyControlsRouter,
  COMPANY_CONTROLS_PATH,
  WORKFORCE_USAGE_PATH,
} from '../../server/workforce/runtime/company-controls-routes.ts';
import { createWorkforceMetricsRouter, WORKFORCE_METRICS_PATH } from '../../server/workforce/runtime/metrics-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';
import { createControlState, seedControls, canStartWork, pauseAgent } from '../../server/workforce/runtime/controls.ts';
import { defaultControlsDocument } from '../../server/modules/approvals/company-policy.ts';
import { retireAgent as rosterRetireAgent } from '../../server/workforce/roster.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = 'appointment-reminder';

/** Every guard and dependency call, in order. Refusal checks read this log. */
let log = [];

let userSeq = 0;
/** A new user id per request, so the in-memory rate limiter on admin and metrics routes never counts across checks. */
const freshUser = (role, companyId) => {
  userSeq += 1;
  return { userId: `u-${userSeq}`, role, ...(companyId === undefined ? {} : { companyId }) };
};

/** Stub authenticate, the same shape as authenticateToken: req.userId, req.userRole and req.user. */
const authenticate = (req, res, next) => {
  log.push('guard:authenticate');
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.userRole = u.role;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  return next();
};

/** Same rule as requireRole in server/middleware/auth.ts: admin always passes, otherwise the role must be listed. */
function requireRole(...roles) {
  return (req, res, next) => {
    log.push(`guard:role(${roles.join('|')})`);
    if (req.userRole === 'admin') return next();
    if (!req.userRole || !roles.includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
    return next();
  };
}

/** The real company scope middleware, wrapped so the call is recorded. It reads req.user.companyId only. */
const recordingCompanyScope = () => {
  const real = requireCompanyScope();
  return (req, res, next) => {
    log.push('guard:companyScope');
    return real(req, res, next);
  };
};

const requireAdmin = requireRole('admin');
const requireAdminOrManager = requireRole('admin', 'manager');

const dep = (name, companyId) => log.push(`dep:${name}:${companyId}`);

const AGENTS = [
  { agentId: 'agent-a-1', companyId: CO_A, roleId: ROLE_ID, status: 'active' },
  { agentId: 'agent-b-1', companyId: CO_B, roleId: ROLE_ID, status: 'active' },
];

const RUNS = [
  { id: 'run-a-1', companyId: CO_A, status: 'completed', version: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', team: { members: [] }, path: [], delegations: [], limits: {}, budget: {}, retry: {}, pendingApproval: null, reason: null },
  { id: 'run-b-1', companyId: CO_B, status: 'completed', version: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', team: { members: [] }, path: [], delegations: [], limits: {}, budget: {}, retry: {}, pendingApproval: null, reason: null },
];

const APPROVALS_BY_COMPANY = {
  [CO_A]: [{ id: 'appr-a-1', companyId: CO_A }],
  [CO_B]: [{ id: 'appr-b-1', companyId: CO_B }],
};

/**
 * One rig per request. Every dependency records its company through dep(). Each fake filters by the company it is
 * given, the way the real service does, so a wrong company shows up as a leaked row.
 */
function rig(overrides = {}) {
  const holder = { state: createControlState() };
  holder.state = seedControls(holder.state, CO_A, [{ agentId: 'agent-a-1', status: 'active' }]);
  holder.state = seedControls(holder.state, CO_B, [{ agentId: 'agent-b-1', status: 'active' }]);

  // The real roster record store. retireAgent below is the real guarded function from server/workforce/roster.ts,
  // so the running-task check and the agent_running refusal are the production rules, not a stand-in.
  const rosterState = {
    catalogue: new Map(),
    companies: new Map(
      [CO_A, CO_B].map((companyId) => [
        companyId,
        new Map(
          AGENTS.filter((a) => a.companyId === companyId).map((a) => [
            a.agentId,
            { companyId, agentId: a.agentId, roleId: a.roleId, teamId: null, channels: [], permissions: [], autonomy: 'assist', status: 'active', retiredAt: null, retiredBy: null },
          ]),
        ),
      ]),
    ),
  };

  const roster = {
    getAgent: (companyId, agentId) => {
      dep('getAgent', companyId);
      return AGENTS.find((a) => a.companyId === companyId && a.agentId === agentId);
    },
    createAgent: (input) => {
      dep('createAgent', input.companyId);
      return { ok: true, agent: { agentId: input.agentId, companyId: input.companyId, status: 'active' } };
    },
    configureAgent: (companyId, agentId, patch) => {
      dep('configureAgent', companyId);
      if (!AGENTS.some((a) => a.companyId === companyId && a.agentId === agentId)) return { ok: false, reason: 'agent_not_found' };
      // Same as the real roster: companyId, roleId and agentId are fixed and cannot be patched.
      if ('companyId' in patch || 'roleId' in patch || 'agentId' in patch) return { ok: false, reason: 'immutable_field' };
      return { ok: true, agent: { agentId, companyId, autonomy: patch.autonomy } };
    },
    setAgentStatus: (companyId, agentId, status) => {
      dep('setAgentStatus', companyId);
      if (!AGENTS.some((a) => a.companyId === companyId && a.agentId === agentId)) return { ok: false, reason: 'agent_not_found' };
      return { ok: true, agent: { agentId, companyId, status } };
    },
    retireAgent: (companyId, agentId, options) => {
      dep('retireAgent', companyId);
      return rosterRetireAgent(rosterState, companyId, agentId, options);
    },
  };

  const adminDeps = {
    controls: holder,
    roster,
    isRosterAgent: (companyId, agentId) => {
      dep('isRosterAgent', companyId);
      return AGENTS.some((a) => a.companyId === companyId && a.agentId === agentId);
    },
    getApprovals: (companyId) => {
      dep('getApprovals', companyId);
      return APPROVALS_BY_COMPANY[companyId] ?? [];
    },
    // Run rows in the shape agentRunsFromRecords produces (agentId, status). Tests pass their own via overrides.runs.
    getRuns: (companyId) => {
      dep('getRuns', companyId);
      return (overrides.runs ?? []).filter((r) => r.companyId === companyId);
    },
  };

  const taskStore = {
    listRuns: (companyId) => {
      dep('listRuns', companyId);
      return RUNS.filter((r) => r.companyId === companyId);
    },
    listAudit: (companyId) => {
      dep('listAudit', companyId);
      return [];
    },
  };

  const controlsStore = (() => {
    const docs = new Map();
    return {
      read: async (companyId) => {
        dep('controlsRead', companyId);
        return docs.get(companyId) ?? null;
      },
      write: async (companyId, controls, expectedVersion) => {
        dep('controlsWrite', companyId);
        const current = docs.get(companyId)?.version ?? 0;
        if (current !== expectedVersion) return { ok: false, reason: 'version_conflict' };
        docs.set(companyId, { version: current + 1, controls });
        return { ok: true, version: current + 1 };
      },
    };
  })();

  const controlsDeps = {
    roles: () => [{ id: ROLE_ID, name: 'Appointment reminder', autonomy: 'assist' }],
    store: controlsStore,
    usage: {
      read: (companyId) => {
        dep('usageRead', companyId);
        return { day: '2026-11-04', runsStarted: 0, spendCentsToday: 0, totals: { runs: 0, toolCalls: 0, tokens: 0, spendCents: 0 } };
      },
    },
    audit: {
      record: (entry) => {
        dep('audit', entry.metadata.companyId);
      },
    },
    now: () => Date.parse('2026-11-04T00:00:00Z'),
  };

  const metricsDeps = {
    getMetrics: () => ({
      companySnapshot: (companyId) => {
        dep('metricsSnapshot', companyId);
        return { companyId, runs: 0 };
      },
      companyAlerts: (companyId) => {
        dep('metricsAlerts', companyId);
        return [];
      },
    }),
  };

  const mounts = {
    admin: createWorkforceAdminRouter(
      { ...adminDeps, ...(overrides.admin ?? {}) },
      { authenticate, requireAdmin, requireManager: requireAdminOrManager, requireCompanyScope: recordingCompanyScope() },
    ),
    tasks: createTaskBoardRouter(
      { store: taskStore, now: () => new Date('2026-11-04T00:00:00Z') },
      { authenticate, requireCompanyScope: recordingCompanyScope(), requireAdminOrManager },
    ),
    controls: createCompanyControlsRouter(
      { ...controlsDeps, ...(overrides.controls ?? {}) },
      { authenticate, requireAdmin, requireCompanyScope: recordingCompanyScope() },
    ),
    metrics: createWorkforceMetricsRouter(metricsDeps, { authenticate, requireAdmin, requireCompanyScope: recordingCompanyScope() }),
  };
  return { holder, mounts, rosterState };
}

/** Starts an express app with one router on an ephemeral port. Requests use node:http on 127.0.0.1 only. */
async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    call(method, path, { user, query = '', body, headers = {} } = {}) {
      const payload = body === undefined || method === 'GET' ? null : JSON.stringify(body);
      const h = { host: 'example.test', ...headers };
      if (user) h['x-test-user'] = JSON.stringify(user);
      if (payload !== null) {
        h['content-type'] = 'application/json';
        h['content-length'] = Buffer.byteLength(payload);
      }
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: `${path}${query}`, method, headers: h }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
            resolve({ status: res.statusCode, body: parsed, raw });
          });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
      });
    },
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

const depCalls = () => log.filter((entry) => entry.startsWith('dep:'));

/**
 * The route table. `allowed` lists the roles the route admits (admin always passes requireRole, so it is listed
 * for clarity). `okStatus` is the success status for an allowed session. `body` is sent on every call.
 */
const ROUTES = [
  // Admin routes (requireAdmin): review inbox, pause and resume.
  { name: 'review inbox', method: 'GET', path: REVIEW_INBOX_PATH, mount: 'admin', allowed: ['admin'], okStatus: 200 },
  { name: 'pause agent', method: 'POST', path: AGENT_PAUSE_PATH.replace(':agentId', 'agent-a-1'), mount: 'admin', allowed: ['admin'], okStatus: 200 },
  { name: 'resume agent', method: 'POST', path: AGENT_RESUME_PATH.replace(':agentId', 'agent-a-1'), mount: 'admin', allowed: ['admin'], okStatus: 200, pausedFirst: true },
  // Admin or manager routes (agent roster writes).
  { name: 'create agent', method: 'POST', path: AGENTS_PATH, mount: 'admin', allowed: ['admin', 'manager'], okStatus: 201, body: { agentId: 'agent-a-2', roleId: ROLE_ID } },
  { name: 'configure agent', method: 'PATCH', path: AGENT_PATH.replace(':agentId', 'agent-a-1'), mount: 'admin', allowed: ['admin', 'manager'], okStatus: 200, body: { autonomy: 'assist' } },
  { name: 'retire agent', method: 'POST', path: AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), mount: 'admin', allowed: ['admin', 'manager'], okStatus: 200 },
  // Task board (admin or manager).
  // The task board chain runs company scope before the role guard, so its order is scope, role.
  { name: 'task board', method: 'GET', path: TASKS_PATH, mount: 'tasks', allowed: ['admin', 'manager'], okStatus: 200, scopeFirst: true },
  { name: 'run history', method: 'GET', path: RUN_HISTORY_PATH, mount: 'tasks', allowed: ['admin', 'manager'], okStatus: 200, scopeFirst: true },
  // Company controls and usage (admin only).
  { name: 'read company controls', method: 'GET', path: COMPANY_CONTROLS_PATH, mount: 'controls', allowed: ['admin'], okStatus: 200 },
  {
    name: 'write company controls',
    method: 'PUT',
    path: COMPANY_CONTROLS_PATH,
    mount: 'controls',
    allowed: ['admin'],
    okStatus: 200,
    body: {
      expectedVersion: 0,
      controls: {
        ...defaultControlsDocument(new Map([[ROLE_ID, 'assist']])),
        roles: { [ROLE_ID]: { enabled: true, tier: 'assist' } },
        budgets: { maxToolCallsPerRun: 10, maxTokensPerRun: 1000, maxSpendCentsPerRun: 100, maxRunsPerCompanyPerDay: 5, maxSpendCentsPerCompanyPerDay: 500 },
      },
    },
  },
  { name: 'usage', method: 'GET', path: WORKFORCE_USAGE_PATH, mount: 'controls', allowed: ['admin'], okStatus: 200 },
  // Metrics (admin only).
  { name: 'metrics', method: 'GET', path: WORKFORCE_METRICS_PATH, mount: 'metrics', allowed: ['admin'], okStatus: 200 },
];

const ALL_ROLES = ['admin', 'manager', 'member'];

for (const route of ROUTES) {
  const label = `${route.method} ${route.path}`;
  const opts = (user, extra = {}) => ({ user, body: route.body ?? {}, ...extra });

  test(`${label}: no identity is refused at authenticate and no dependency runs`, async () => {
    log = [];
    const r = rig();
    const srv = await serve(r.mounts[route.mount]);
    try {
      const res = await srv.call(route.method, route.path, opts(null));
      assert.equal(res.status, 401);
      assert.deepEqual(log, ['guard:authenticate']);
    } finally {
      await srv.close();
    }
  });

  test(`${label}: a member is refused at the role guard and no dependency runs`, async () => {
    log = [];
    const r = rig();
    const srv = await serve(r.mounts[route.mount]);
    try {
      const res = await srv.call(route.method, route.path, opts(freshUser('member', CO_A)));
      assert.equal(res.status, 403);
      assert.deepEqual(depCalls(), []);
      if (!route.scopeFirst) assert.ok(!log.includes('guard:companyScope'), 'the company guard must not run after a role refusal');
    } finally {
      await srv.close();
    }
  });

  test(`${label}: a session with no company, or a company that is not a UUID, is refused and no dependency runs`, async () => {
    log = [];
    const r = rig();
    const srv = await serve(r.mounts[route.mount]);
    try {
      const noCompany = await srv.call(route.method, route.path, opts(freshUser(route.allowed[0])));
      assert.equal(noCompany.status, 403);
      const badCompany = await srv.call(route.method, route.path, opts(freshUser(route.allowed[0], 'not-a-uuid')));
      assert.equal(badCompany.status, 403);
      assert.deepEqual(depCalls(), []);
    } finally {
      await srv.close();
    }
  });

  test(`${label}: guards run in the order authenticate, role, company scope`, async () => {
    log = [];
    const r = rig();
    const srv = await serve(r.mounts[route.mount]);
    try {
      await srv.call(route.method, route.path, opts(freshUser(route.allowed[0], CO_A)));
      const guards = log.filter((entry) => entry.startsWith('guard:'));
      assert.equal(guards[0], 'guard:authenticate');
      if (route.scopeFirst) {
        assert.equal(guards[1], 'guard:companyScope');
        assert.ok(guards[2].startsWith('guard:role('), `third guard was ${guards[2]}`);
      } else {
        assert.ok(guards[1].startsWith('guard:role('), `second guard was ${guards[1]}`);
        assert.equal(guards[2], 'guard:companyScope');
      }
    } finally {
      await srv.close();
    }
  });

  test(`${label}: the allowed roles get ${route.okStatus} and the other roles are refused`, async () => {
    for (const role of ALL_ROLES) {
      log = [];
      const r = rig();
      if (route.pausedFirst) r.holder.state = pauseAgent(r.holder.state, CO_A, 'agent-a-1', { kind: 'human', userId: 'setup' }).state;
      const srv = await serve(r.mounts[route.mount]);
      try {
        const res = await srv.call(route.method, route.path, opts(freshUser(role, CO_A)));
        if (route.allowed.includes(role)) {
          assert.equal(res.status, route.okStatus, `${role} got ${res.status}: ${res.raw}`);
        } else {
          assert.equal(res.status, 403, `${role} got ${res.status}`);
          assert.deepEqual(depCalls(), [], `${role} refusal must not reach a dependency`);
        }
      } finally {
        await srv.close();
      }
    }
  });

  test(`${label}: a company sent in query, body or header is ignored and dependencies see the session company only`, async () => {
    log = [];
    const r = rig();
    const srv = await serve(r.mounts[route.mount]);
    try {
      const role = route.allowed[0];
      const res = await srv.call(route.method, route.path, {
        user: freshUser(role, CO_A),
        query: `?companyId=${CO_B}&company_id=${CO_B}`,
        body: { ...(route.body ?? {}), companyId: CO_B, company_id: CO_B },
        headers: { 'x-company-id': CO_B },
      });
      assert.ok(res.status < 500, `got ${res.status}: ${res.raw}`);
      const calls = depCalls();
      for (const call of calls) {
        assert.ok(call.endsWith(`:${CO_A}`), `${call} received a company other than the session company`);
      }
      assert.ok(!res.raw.includes(CO_B), 'response contains company B identifiers');
      assert.ok(!res.raw.includes('run-b-1') && !res.raw.includes('appr-b-1') && !res.raw.includes('agent-b-1'));
    } finally {
      await srv.close();
    }
  });
}

test('task board and run history: company A admin sees only company A runs', async () => {
  log = [];
  const r = rig();
  const srv = await serve(r.mounts.tasks);
  try {
    const res = await srv.call('GET', TASKS_PATH, { user: freshUser('manager', CO_A) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tasks.map((t) => t.runId), ['run-a-1']);
    const history = await srv.call('GET', RUN_HISTORY_PATH, { user: freshUser('admin', CO_A) });
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.runs.map((t) => t.runId), ['run-a-1']);
  } finally {
    await srv.close();
  }
});

test('review inbox: company A admin sees only company A approvals', async () => {
  log = [];
  const r = rig();
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('GET', REVIEW_INBOX_PATH, { user: freshUser('admin', CO_A) });
    assert.equal(res.status, 200);
    assert.ok(!res.raw.includes('appr-b-1'));
  } finally {
    await srv.close();
  }
});

test('create agent: the company comes from the session, not the body', async () => {
  log = [];
  const r = rig();
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('POST', AGENTS_PATH, {
      user: freshUser('manager', CO_A),
      body: { agentId: 'agent-x', roleId: ROLE_ID, companyId: CO_B },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(depCalls(), [`dep:createAgent:${CO_A}`]);
  } finally {
    await srv.close();
  }
});

test('configure and retire: an agent on another company is not found and is not changed', async () => {
  log = [];
  const r = rig();
  const srv = await serve(r.mounts.admin);
  try {
    const patch = await srv.call('PATCH', AGENT_PATH.replace(':agentId', 'agent-b-1'), {
      user: freshUser('admin', CO_A),
      body: { autonomy: 'assist' },
    });
    assert.equal(patch.status, 404);

    const retire = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-b-1'), {
      user: freshUser('admin', CO_A),
    });
    assert.equal(retire.status, 404);
    assert.equal(retire.body.error, 'agent_not_found');
    assert.equal(r.rosterState.companies.get(CO_B).get('agent-b-1').status, 'active', 'company B agent must stay active');
    assert.equal(r.rosterState.companies.get(CO_B).get('agent-b-1').retiredAt, null);
  } finally {
    await srv.close();
  }
});

test('retire: a task in progress refuses with 409 agent_running, and neither the roster nor the work gate changes', async () => {
  log = [];
  const r = rig({
    runs: [{ id: 'run-a-live', companyId: CO_A, agentId: 'agent-a-1', status: 'running' }],
  });
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('manager', CO_A) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'agent_running');
    assert.equal(r.rosterState.companies.get(CO_A).get('agent-a-1').status, 'active', 'roster record must stay active');
    assert.equal(canStartWork(r.holder.state, CO_A, 'agent-a-1').allowed, true, 'work gate must stay open after a refusal');
  } finally {
    await srv.close();
  }
});

test('retire: a finished run does not block retirement, and the roster and work gate both close', async () => {
  log = [];
  const r = rig({
    runs: [{ id: 'run-a-done', companyId: CO_A, agentId: 'agent-a-1', status: 'completed' }],
  });
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('manager', CO_A) });
    assert.equal(res.status, 200);
    assert.equal(r.rosterState.companies.get(CO_A).get('agent-a-1').status, 'retired');
    assert.equal(canStartWork(r.holder.state, CO_A, 'agent-a-1').allowed, false, 'work gate must close on retire');
  } finally {
    await srv.close();
  }
});

test('retire: a run on another company does not block, and a running run on another company does not leak in', async () => {
  log = [];
  const r = rig({
    runs: [{ id: 'run-b-live', companyId: CO_B, agentId: 'agent-a-1', status: 'running' }],
  });
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('admin', CO_A) });
    assert.equal(res.status, 200, `got ${res.status}: ${res.raw}`);
    assert.ok(depCalls().every((c) => c.endsWith(`:${CO_A}`)), 'the run check must only read company A');
  } finally {
    await srv.close();
  }
});

test('retire: a run check that throws fails closed with 409 run_check_unavailable', async () => {
  log = [];
  const r = rig({
    admin: {
      getRuns: () => {
        throw new Error('db down');
      },
    },
  });
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('admin', CO_A) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'run_check_unavailable');
    assert.equal(r.rosterState.companies.get(CO_A).get('agent-a-1').status, 'active');
    assert.equal(canStartWork(r.holder.state, CO_A, 'agent-a-1').allowed, true);
  } finally {
    await srv.close();
  }
});

test('pause and resume: an agent on another company is refused and its work gate stays open', async () => {
  log = [];
  const r = rig();
  const srv = await serve(r.mounts.admin);
  try {
    const res = await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-b-1'), {
      user: freshUser('admin', CO_A),
      body: { companyId: CO_B },
    });
    assert.equal(res.status, 404);
    assert.equal(canStartWork(r.holder.state, CO_B, 'agent-b-1').allowed, true);
  } finally {
    await srv.close();
  }
});

test('manager write routes fail closed to admin only when no manager guard is supplied', async () => {
  log = [];
  const holder = { state: createControlState() };
  const router = createWorkforceAdminRouter(
    {
      controls: holder,
      roster: { createAgent: () => ({ ok: true, agent: {} }), configureAgent: () => ({ ok: true, agent: {} }), setAgentStatus: () => ({ ok: true, agent: {} }), getAgent: () => undefined },
    },
    { authenticate, requireAdmin, requireCompanyScope: recordingCompanyScope() },
  );
  const srv = await serve(router);
  try {
    const manager = await srv.call('POST', AGENTS_PATH, { user: freshUser('manager', CO_A), body: { agentId: 'a', roleId: ROLE_ID } });
    assert.equal(manager.status, 403);
    const admin = await srv.call('POST', AGENTS_PATH, { user: freshUser('admin', CO_A), body: { agentId: 'a', roleId: ROLE_ID } });
    assert.equal(admin.status, 201);
  } finally {
    await srv.close();
  }
});

test('production wiring: a manager can configure and retire an agent, a member cannot, and pause stays admin only', async () => {
  // Same guard set as server/routes.ts: requireAdmin plus requireManager (admin or manager).
  log = [];
  const r = rig();
  const srv = await serve(r.mounts.admin);
  try {
    const configure = await srv.call('PATCH', AGENT_PATH.replace(':agentId', 'agent-a-1'), {
      user: freshUser('manager', CO_A),
      body: { autonomy: 'assist' },
    });
    assert.equal(configure.status, 200, `manager configure got ${configure.status}: ${configure.raw}`);

    const retire = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('manager', CO_A) });
    assert.equal(retire.status, 200, `manager retire got ${retire.status}: ${retire.raw}`);
    assert.equal(r.rosterState.companies.get(CO_A).get('agent-a-1').status, 'retired');

    log = [];
    const memberConfigure = await srv.call('PATCH', AGENT_PATH.replace(':agentId', 'agent-a-1'), {
      user: freshUser('member', CO_A),
      body: { autonomy: 'assist' },
    });
    assert.equal(memberConfigure.status, 403);
    const memberRetire = await srv.call('POST', AGENT_RETIRE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('member', CO_A) });
    assert.equal(memberRetire.status, 403);
    assert.deepEqual(depCalls(), [], 'a member refusal must not reach a dependency');

    const managerPause = await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-a-1'), { user: freshUser('manager', CO_A) });
    assert.equal(managerPause.status, 403, 'pause stays admin only');
  } finally {
    await srv.close();
  }
});

test('a missing dependency returns 503 and never a partial answer', async () => {
  log = [];
  const r = rig({ controls: { store: undefined } });
  const srv = await serve(r.mounts.controls);
  try {
    const res = await srv.call('GET', COMPANY_CONTROLS_PATH, { user: freshUser('admin', CO_A) });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'dependency_not_configured');
  } finally {
    await srv.close();
  }
});
