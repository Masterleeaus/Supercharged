/**
 * Permission and tenant-isolation checks for the workforce router factories, with fakes and real express.
 *
 * Each factory is mounted with stub data and the real company-scope middleware. The role guard copies the rule of
 * requireRole in server/middleware/auth.ts (see below), with the same roles production passes in server/routes.ts:
 * admin only for the review inbox and pause/resume, admin or manager for the roster, shadow changes, dead
 * letters and the cockpit activity feed. The authenticate stub sets req.user and req.userRole the way
 * authenticateToken does, but reads the identity from a test header instead of a JWT.
 *
 * For every route, the checks are:
 *   - no identity: refused with 401, and no dependency runs
 *   - member: refused with 403 on every route here, and no dependency runs
 *   - no company on the session, or a company that is not a UUID: refused with 403, and no dependency runs
 *   - admin or manager (by route): allowed; a manager is refused on the admin-only routes
 *   - cross-company: the company in the query, body and header is ignored; dependencies see the session company only
 *
 * Route specific checks: the roster and shadow lists only return the session company's rows; a shadow decision
 * takes its role from the session, not the body; pause does not touch another company's agent.
 *
 * Not covered here: rate limiting (the test uses a new user id per request), the routes inline in server/routes.ts,
 * and live requests against the mounted app. See the checklist item in section 12 for what is still open.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/security/route-permissions.test.mjs
 */
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createWorkforceRosterRouter, WORKFORCE_AGENTS_PATH } from '../../server/routes/workforce-roster-routes.ts';
import {
  createWorkforceAdminRouter,
  REVIEW_INBOX_PATH,
  AGENT_PAUSE_PATH,
  AGENT_RESUME_PATH,
} from '../../server/workforce/runtime/workforce-admin-routes.ts';
import {
  createShadowRouter,
  SHADOW_PENDING_PATH,
  SHADOW_APPROVE_PATH,
  SHADOW_REJECT_PATH,
  SHADOW_RETRY_PATH,
} from '../../server/workforce/runtime/shadow-routes.ts';
import { createDeadLetterRouter, DEAD_LETTER_PATH } from '../../server/routes/dead-letter-routes.ts';
import { createCockpitRouter, ACTIVITY_PATH } from '../../server/routes/cockpit-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';
import { createControlState, seedControls, canStartWork } from '../../server/workforce/runtime/controls.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';

let userSeq = 0;
/** A new user id for each request, so the in-memory rate limiter on admin routes never counts across checks. */
const freshUser = (role, companyId) => {
  userSeq += 1;
  return { userId: `u-${userSeq}`, role, ...(companyId === undefined ? {} : { companyId }) };
};

/** Stub authenticate, the same shape as authenticateToken: req.userId, req.userRole and req.user. */
const authenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.userRole = u.role;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  return next();
};

/**
 * Same rule as requireRole in server/middleware/auth.ts: admin always passes, otherwise the role must be listed.
 * Copied here because auth.ts imports without a file extension and cannot be loaded by node's ESM loader in tests.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.userRole === 'admin') return next();
    if (!req.userRole || !roles.includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });
    return next();
  };
}
const requireAdmin = requireRole('admin');
const requireApprover = requireRole('admin', 'manager');

const AGENTS = [
  { agentId: 'agent-a-1', companyId: CO_A, roleId: 'appointment-reminder', status: 'active' },
  { agentId: 'agent-b-1', companyId: CO_B, roleId: 'appointment-reminder', status: 'active' },
];
const SHADOW_ROWS = [
  { id: 'chg-a-1', companyId: CO_A, status: 'pending' },
  { id: 'chg-b-1', companyId: CO_B, status: 'pending' },
];
const DEAD_ROWS = [{ id: 'dl-a-1', companyId: CO_A }, { id: 'dl-b-1', companyId: CO_B }];

/**
 * One set of fakes for one request. Every dependency records the company it was called with in `sensitive`.
 * Each fake filters by the company it is given, the way the real service does, so a wrong company shows up.
 */
function rig() {
  const sensitive = [];
  const holder = { state: createControlState() };
  holder.state = seedControls(holder.state, CO_A, [{ agentId: 'agent-a-1', status: 'active' }]);
  holder.state = seedControls(holder.state, CO_B, [{ agentId: 'agent-b-1', status: 'active' }]);

  const shadowDecider = {
    decide: async (companyId, id, approver) => {
      sensitive.push({ dep: 'decide', companyId, id, approver });
      return { ok: true, status: 'approved' };
    },
    retry: async (companyId, id, approver) => {
      sensitive.push({ dep: 'retry', companyId, id, approver });
      return { ok: true, status: 'approved' };
    },
  };

  const mounts = {
    roster: createWorkforceRosterRouter(
      {
        listAgents: (companyId) => {
          sensitive.push({ dep: 'listAgents', companyId });
          return AGENTS.filter((a) => a.companyId === companyId).map(({ companyId: _c, ...rest }) => rest);
        },
      },
      { authenticate, requireCompanyScope: requireCompanyScope(), requireApprover },
    ),
    admin: createWorkforceAdminRouter(
      {
        controls: holder,
        getApprovals: (companyId) => {
          sensitive.push({ dep: 'getApprovals', companyId });
          return [];
        },
        getRuns: (companyId) => {
          sensitive.push({ dep: 'getRuns', companyId });
          return [];
        },
        isRosterAgent: (companyId, agentId) => AGENTS.some((a) => a.companyId === companyId && a.agentId === agentId),
      },
      { authenticate, requireAdmin, requireCompanyScope: requireCompanyScope() },
    ),
    shadow: createShadowRouter(
      {
        shadow: shadowDecider,
        listPending: (companyId) => {
          sensitive.push({ dep: 'listPending', companyId });
          return SHADOW_ROWS;
        },
      },
      { authenticate, requireCompanyScope: requireCompanyScope(), requireApprover },
    ),
    dead: createDeadLetterRouter(
      {
        listDeadLetterDeliveries: (companyId, limit) => {
          sensitive.push({ dep: 'listDeadLetters', companyId, limit });
          return DEAD_ROWS.filter((r) => r.companyId === companyId);
        },
      },
      { authenticate, requireCompanyScope: requireCompanyScope(), requireApprover },
    ),
    cockpit: createCockpitRouter(
      {
        loadApprovals: (companyId) => {
          sensitive.push({ dep: 'loadApprovals', companyId });
          return [];
        },
      },
      { authenticate, requireCompanyScope: requireCompanyScope(), requireApprover },
    ),
  };
  return { sensitive, holder, mounts };
}

/**
 * Starts an express app with the given routers on an ephemeral port. Requests go through node:http so the Host
 * header can be set: the cockpit activity route is only mounted for the workforce host.
 */
async function serve(routers) {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use(r);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    call(method, path, { user, query = '', body, headers = {}, host = 'superchargedat.work' } = {}) {
      const payload = body === undefined || method === 'GET' ? null : JSON.stringify(body);
      const h = { host, ...headers };
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
            resolve({ status: res.statusCode, body: parsed });
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

/**
 * The route table. `mount` names the router in rig().mounts. `adminOnly` routes refuse managers.
 * `okStatus` is the status an allowed session gets. Pause and resume are covered in their own tests.
 */
const ROUTES = [
  { name: 'roster list', method: 'GET', path: WORKFORCE_AGENTS_PATH, mount: 'roster', adminOnly: false, okStatus: 200 },
  { name: 'review inbox', method: 'GET', path: REVIEW_INBOX_PATH, mount: 'admin', adminOnly: true, okStatus: 200 },
  { name: 'shadow pending', method: 'GET', path: SHADOW_PENDING_PATH, mount: 'shadow', adminOnly: false, okStatus: 200 },
  { name: 'shadow approve', method: 'POST', path: SHADOW_APPROVE_PATH.replace(':id', 'chg-a-1'), mount: 'shadow', adminOnly: false, okStatus: 200 },
  { name: 'shadow reject', method: 'POST', path: SHADOW_REJECT_PATH.replace(':id', 'chg-a-1'), mount: 'shadow', adminOnly: false, okStatus: 200 },
  { name: 'shadow retry', method: 'POST', path: SHADOW_RETRY_PATH.replace(':id', 'chg-a-1'), mount: 'shadow', adminOnly: false, okStatus: 200 },
  { name: 'dead letters', method: 'GET', path: DEAD_LETTER_PATH, mount: 'dead', adminOnly: false, okStatus: 200 },
  { name: 'cockpit activity', method: 'GET', path: ACTIVITY_PATH, mount: 'cockpit', adminOnly: false, okStatus: 200 },
];

for (const route of ROUTES) {
  test(`${route.method} ${route.path}: no identity is refused and no dependency runs`, async () => {
    const r = rig();
    const srv = await serve([r.mounts[route.mount]]);
    try {
      const res = await srv.call(route.method, route.path, { user: null });
      assert.equal(res.status, 401);
      assert.deepEqual(r.sensitive, []);
    } finally {
      await srv.close();
    }
  });

  test(`${route.method} ${route.path}: a member is refused and no dependency runs`, async () => {
    const r = rig();
    const srv = await serve([r.mounts[route.mount]]);
    try {
      const res = await srv.call(route.method, route.path, { user: freshUser('member', CO_A), body: {} });
      assert.equal(res.status, 403);
      assert.deepEqual(r.sensitive, []);
    } finally {
      await srv.close();
    }
  });

  test(`${route.method} ${route.path}: a session with no company, or a bad company, is refused and no dependency runs`, async () => {
    const r = rig();
    const srv = await serve([r.mounts[route.mount]]);
    try {
      const noCompany = await srv.call(route.method, route.path, { user: freshUser('admin'), body: {} });
      assert.equal(noCompany.status, 403);
      const badCompany = await srv.call(route.method, route.path, { user: freshUser('admin', 'not-a-uuid'), body: {} });
      assert.equal(badCompany.status, 403);
      assert.deepEqual(r.sensitive, []);
    } finally {
      await srv.close();
    }
  });

  test(`${route.method} ${route.path}: admin is allowed and a manager is ${route.adminOnly ? 'refused' : 'allowed'}`, async () => {
    const r = rig();
    const srv = await serve([r.mounts[route.mount]]);
    try {
      const admin = await srv.call(route.method, route.path, { user: freshUser('admin', CO_A), body: {} });
      assert.equal(admin.status, route.okStatus, `admin got ${admin.status}`);
      const manager = await srv.call(route.method, route.path, { user: freshUser('manager', CO_A), body: {} });
      if (route.adminOnly) {
        assert.equal(manager.status, 403);
      } else {
        assert.equal(manager.status, route.okStatus, `manager got ${manager.status}`);
      }
    } finally {
      await srv.close();
    }
  });

  test(`${route.method} ${route.path}: a company sent in query, body or header is ignored`, async () => {
    const r = rig();
    const srv = await serve([r.mounts[route.mount]]);
    try {
      const role = route.adminOnly ? 'admin' : 'manager';
      const res = await srv.call(route.method, route.path, {
        user: freshUser(role, CO_A),
        query: `?companyId=${CO_B}&limit=5`,
        body: { companyId: CO_B, company_id: CO_B, role: 'admin' },
        headers: { 'x-company-id': CO_B },
      });
      assert.equal(res.status, route.okStatus, `got ${res.status}`);
      assert.ok(r.sensitive.length > 0, 'a dependency should have run for the session company');
      for (const call of r.sensitive) {
        assert.equal(call.companyId, CO_A, `${call.dep} was called with another company`);
      }
      // No row of company B may come back in any list.
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes(CO_B), 'response contains company B data');
      assert.ok(!text.includes('chg-b-1') && !text.includes('dl-b-1') && !text.includes('agent-b-1'));
    } finally {
      await srv.close();
    }
  });
}

test('roster returns only the session company agents', async () => {
  const r = rig();
  const srv = await serve([r.mounts.roster]);
  try {
    const res = await srv.call('GET', WORKFORCE_AGENTS_PATH, { user: freshUser('manager', CO_A) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => i.id), ['agent-a-1']);
  } finally {
    await srv.close();
  }
});

test('shadow pending list drops rows that belong to another company', async () => {
  const r = rig();
  const srv = await serve([r.mounts.shadow]);
  try {
    const res = await srv.call('GET', SHADOW_PENDING_PATH, { user: freshUser('manager', CO_A) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changes.map((c) => c.id), ['chg-a-1']);
  } finally {
    await srv.close();
  }
});

test('shadow approve takes the approver role from the session, not the body', async () => {
  const r = rig();
  const srv = await serve([r.mounts.shadow]);
  try {
    const res = await srv.call('POST', SHADOW_APPROVE_PATH.replace(':id', 'chg-a-1'), {
      user: freshUser('manager', CO_A),
      body: { role: 'admin', companyId: CO_B, id: 'someone-else' },
    });
    assert.equal(res.status, 200);
    const decide = r.sensitive.find((c) => c.dep === 'decide');
    assert.ok(decide, 'decide should run');
    assert.equal(decide.companyId, CO_A);
    assert.equal(decide.id, 'chg-a-1');
    assert.equal(decide.approver.role, 'manager');
  } finally {
    await srv.close();
  }
});

test('dead letter limit is clamped to 100 whatever the query says', async () => {
  const r = rig();
  const srv = await serve([r.mounts.dead]);
  try {
    const res = await srv.call('GET', DEAD_LETTER_PATH, { user: freshUser('manager', CO_A), query: '?limit=99999' });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 100);
  } finally {
    await srv.close();
  }
});

test('pause and resume: a manager is refused, and an admin pausing another company agent leaves that agent alone', async () => {
  const r = rig();
  const before = r.holder.state;
  const srv = await serve([r.mounts.admin]);
  try {
    const managerPause = await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-a-1'), {
      user: freshUser('manager', CO_A),
    });
    assert.equal(managerPause.status, 403);
    assert.equal(r.holder.state, before, 'a refused pause changes nothing');

    // The company B agent id is sent by an admin of company A. Its state for company B must not change.
    await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-b-1'), {
      user: freshUser('admin', CO_A),
      body: { companyId: CO_B },
    });
    assert.equal(canStartWork(r.holder.state, CO_B, 'agent-b-1').allowed, true, 'company B agent is still allowed to work');

    const ownPause = await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-a-1'), {
      user: freshUser('admin', CO_A),
    });
    assert.equal(ownPause.status, 200);
    assert.equal(canStartWork(r.holder.state, CO_A, 'agent-a-1').allowed, false);
    assert.equal(canStartWork(r.holder.state, CO_B, 'agent-b-1').allowed, true);

    const resume = await srv.call('POST', AGENT_RESUME_PATH.replace(':agentId', 'agent-a-1'), {
      user: freshUser('admin', CO_A),
    });
    assert.equal(resume.status, 200);
  } finally {
    await srv.close();
  }
});

// The pause route checks the caller's roster through isRosterAgent. An agent of another company is not on it, so it gets 404.
test('pausing an agent that is not on the caller company roster is refused', async () => {
  const r = rig();
  const srv = await serve([r.mounts.admin]);
  try {
    const res = await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-b-1'), {
      user: freshUser('admin', CO_A),
    });
    assert.equal(res.status, 404, 'an agent of another company must not be pausable from company A');
    assert.equal(canStartWork(r.holder.state, CO_B, 'agent-b-1').allowed, true);
  } finally {
    await srv.close();
  }
});

test('pause with no identity is refused and leaves the control state alone', async () => {
  const r = rig();
  const before = r.holder.state;
  const srv = await serve([r.mounts.admin]);
  try {
    const res = await srv.call('POST', AGENT_PAUSE_PATH.replace(':agentId', 'agent-a-1'), { user: null });
    assert.equal(res.status, 401);
    assert.equal(r.holder.state, before);
  } finally {
    await srv.close();
  }
});
