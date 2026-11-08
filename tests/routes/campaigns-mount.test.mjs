/**
 * Route-level tests for the production mount of the campaigns router (server/routes.ts, under /api/comms).
 * The mount chain is copied from routes.ts: stub authenticate, real requireCompanyScope, the actor step,
 * the real deskModeMiddleware with the production host config, then createCampaignRouterForProduction.
 * The campaign service is a stub passed through deps.service, so no database is needed.
 * Requests go through node:http so the Host header can be set (fetch does not allow it).
 * Run: node --test --experimental-transform-types tests/routes/campaigns-mount.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const { createCampaignRouterForProduction } = await import('../../server/modules/campaigns/campaigns-router.ts');
const { requireCompanyScope } = await import('../../server/middleware/company-scope.ts');
const { deskModeMiddleware } = await import('../../server/modules/desk-modes/index.ts');
const { buildModeConfig } = await import('../../server/modules/desk-modes/mode-resolver.ts');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const MEMBER_A = { userId: 'u-mem', role: 'member', companyId: CO_A };
const STAFF_A = { userId: 'u-staff', role: 'manager', companyId: CO_A };
const NO_COMPANY = { userId: 'u-x', role: 'member' };

const COMMS_HOST = 'syncedat.work';
const WORKFORCE_HOST = 'superchargedat.work';
// Same host sets as DEFAULT_MODE_CONFIG in server/routes/cockpit-routes.ts.
const modeConfig = buildModeConfig({ workforceHosts: WORKFORCE_HOST, commsHosts: COMMS_HOST });

// Stub authenticate: the test identity arrives in the x-test-user header. No header means refused.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  // The real authenticate sets userRole, and the production adapter forwards only that field to requireRole.
  req.userRole = u.role;
  next();
};

// Role guard with the semantics of middleware/auth requireRole: admin passes, otherwise the role must be listed.
const roleGuard = (...roles) => (req, res, next) => {
  const role = req.userRole;
  if (role === 'admin' || roles.includes(role)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

// Same step as the setCommsActor middleware in server/routes.ts.
const setCommsActor = (req, res, next) => {
  if (typeof req.userId === 'string' && req.userId !== '') res.locals.actor = { kind: 'human', id: req.userId };
  next();
};

function makeService() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return name === 'listJobs' ? [] : { id: 'camp-1' };
  };
  return {
    calls,
    service: {
      listJobs: record('listJobs'),
      createCampaign: record('createCampaign'),
    },
  };
}

async function start() {
  const { calls, service } = makeService();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/comms',
    stubAuthenticate,
    requireCompanyScope(),
    setCommsActor,
    deskModeMiddleware(modeConfig),
    createCampaignRouterForProduction({ service, store: null, approvals: null, transport: null, companySettings: null, suppression: null, requireRole: roleGuard }),
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    calls,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
    call: ({ method, path, host = COMMS_HOST, user, body }) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { host };
        if (user) headers['x-test-user'] = JSON.stringify(user);
        if (payload !== undefined) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = Buffer.byteLength(payload);
        }
        const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch { parsed = null; }
            resolve({ status: res.statusCode, body: parsed });
          });
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      }),
  };
}

test('unauthenticated requests are refused and the service is not reached', async () => {
  const srv = await start();
  try {
    const res = await srv.call({ method: 'GET', path: '/api/comms/jobs', user: null });
    assert.equal(res.status, 401);
    assert.equal(srv.calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('a request from the workforce host gets 404 even when authenticated', async () => {
  const srv = await start();
  try {
    const res = await srv.call({ method: 'GET', path: '/api/comms/jobs', host: WORKFORCE_HOST, user: MEMBER_A });
    assert.equal(res.status, 404);
    assert.equal(srv.calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('an unknown host gets 404 and the service is not reached', async () => {
  const srv = await start();
  try {
    const res = await srv.call({ method: 'GET', path: '/api/comms/jobs', host: 'evil.example', user: MEMBER_A });
    assert.equal(res.status, 404);
    assert.equal(srv.calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('a user with no company is refused with 403 before the service runs', async () => {
  const srv = await start();
  try {
    const res = await srv.call({ method: 'GET', path: '/api/comms/jobs', user: NO_COMPANY });
    assert.equal(res.status, 403);
    assert.equal(srv.calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('an authenticated manager on the comms host reads jobs for the session company only', async () => {
  const srv = await start();
  try {
    const res = await srv.call({ method: 'GET', path: `/api/comms/jobs?companyId=${CO_B}`, user: STAFF_A });
    assert.equal(res.status, 200);
    assert.equal(srv.calls.length, 1);
    assert.equal(srv.calls[0].name, 'listJobs');
    assert.equal(srv.calls[0].args[0], CO_A);
  } finally {
    await srv.close();
  }
});

test('a member is refused on a staff-only route with 403 and the service is not reached', async () => {
  const srv = await start();
  try {
    const res = await srv.call({ method: 'GET', path: '/api/comms/jobs', user: MEMBER_A });
    assert.equal(res.status, 403);
    assert.equal(srv.calls.length, 0);
  } finally {
    await srv.close();
  }
});

test('a company id in the request body is ignored; the session company is used', async () => {
  const srv = await start();
  try {
    const res = await srv.call({
      method: 'POST',
      path: '/api/comms/campaigns',
      user: STAFF_A,
      body: { name: 'Spring', channel: 'email', audienceId: 'aud-1', companyId: CO_B, company_id: CO_B },
    });
    assert.equal(res.status, 201);
    assert.equal(srv.calls.length, 1);
    assert.equal(srv.calls[0].name, 'createCampaign');
    assert.equal(srv.calls[0].args[0], CO_A);
    assert.equal(srv.calls[0].args[1].companyId, undefined);
    assert.equal(srv.calls[0].args[1].company_id, undefined);
  } finally {
    await srv.close();
  }
});
