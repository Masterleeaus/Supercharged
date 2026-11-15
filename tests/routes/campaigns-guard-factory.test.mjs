/**
 * Guard wiring for the production campaigns mount. Regression test for commit ebe4fe3: registerWorkforceCommsRoutes
 * must pass the role guard FACTORY (requireRole) to createCampaignRouterForProduction, not a built middleware.
 * The router calls deps.requireRole('admin', 'manager') for its staff-only routes, so this test records the
 * arguments of every factory call and checks that a member is refused on a staff-only route.
 * Same mount chain as tests/routes/campaigns-mount.test.mjs, with a recording requireRole stub.
 * Run: node --test --experimental-transform-types tests/routes/campaigns-guard-factory.test.mjs
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
const COMMS_HOST = 'syncedat.work';
const WORKFORCE_HOST = 'superchargedat.work';
const modeConfig = buildModeConfig({ workforceHosts: WORKFORCE_HOST, commsHosts: COMMS_HOST });

const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  req.userRole = u.role;
  next();
};

const setCommsActor = (req, res, next) => {
  if (typeof req.userId === 'string' && req.userId !== '') res.locals.actor = { kind: 'human', id: req.userId };
  next();
};

/**
 * Stand-in for requireRole from server/middleware/auth.ts: a factory that returns a guard.
 * Every factory call is recorded so the test can see the roles the router asked for.
 */
function recordingRequireRole(factoryCalls) {
  return (...roles) => {
    factoryCalls.push(roles);
    return (req, res, next) => {
      if (req.userRole === 'admin' || roles.includes(req.userRole)) return next();
      return res.status(403).json({ error: 'Insufficient permissions' });
    };
  };
}

async function start() {
  const factoryCalls = [];
  const serviceCalls = [];
  const service = new Proxy(
    {},
    {
      get: (_t, name) => (...args) => {
        serviceCalls.push({ name: String(name), args });
        return Promise.resolve({ id: 'x' });
      },
    },
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/api/comms',
    stubAuthenticate,
    requireCompanyScope(),
    setCommsActor,
    deskModeMiddleware(modeConfig),
    createCampaignRouterForProduction({
      service,
      store: null,
      approvals: null,
      transport: null,
      companySettings: null,
      suppression: null,
      requireRole: recordingRequireRole(factoryCalls),
    }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = ({ method, path, user, body }) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { Host: COMMS_HOST, 'x-test-user': JSON.stringify(user) };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  return { factoryCalls, serviceCalls, call, close: () => new Promise((r) => server.close(r)) };
}

test('the production mount asks the role factory for exactly admin and manager', async () => {
  const srv = await start();
  try {
    assert.ok(srv.factoryCalls.length >= 1, 'requireRole factory was never called');
    for (const roles of srv.factoryCalls) assert.deepEqual(roles, ['admin', 'manager']);
  } finally {
    await srv.close();
  }
});

test('a member is refused on a staff-only campaigns route and the service is not reached', async () => {
  const srv = await start();
  try {
    const res = await srv.call({
      method: 'POST',
      path: '/api/comms/audiences',
      user: { userId: 'u-mem', role: 'member', companyId: CO_A },
      body: { name: 'a', channel: 'email' },
    });
    assert.equal(res.status, 403);
    assert.equal(srv.serviceCalls.length, 0);
  } finally {
    await srv.close();
  }
});
