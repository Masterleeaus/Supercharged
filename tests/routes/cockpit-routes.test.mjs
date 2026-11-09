/**
 * Tests for server/routes/cockpit-routes.ts.
 * Stub auth guards stand in for the real auth middleware (the router takes them as parameters).
 * The real requireCompanyScope and the real deskModeMiddleware / requireModule run, so company scope and
 * mode guards are exercised. Real express on an ephemeral port. Requests use node:http so the Host header
 * can be set (fetch does not allow it).
 * Run: node --test --experimental-transform-types tests/routes/cockpit-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import express from 'express';

// Silence logs from imported server code: the test runner uses stdout for its IPC.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

const {
  createCockpitRouter,
  DEFAULT_MODE_CONFIG,
  ACTIVITY_PATH,
  DESK_MODE_PATH,
  CAMPAIGN_RESPONSES_PATH,
} = await import('../../server/routes/cockpit-routes.ts');
const { requireCompanyScope } = await import('../../server/middleware/company-scope.ts');
const { resolveDeskMode } = await import('../../server/modules/desk-modes/mode-resolver.ts');
const { sessionDeskMode } = await import('../../server/modules/desk-modes/session-mode.ts');

const WORKFORCE_HOST = 'superchargedat.work';
const COMMS_HOST = 'syncedat.work';
const UNKNOWN_HOST = 'evil.example';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const USER_A = { userId: 'u-a', role: 'admin', companyId: CO_A };
const USER_NO_COMPANY = { userId: 'u-x', role: 'admin' };

// Which Desk host each route belongs to. The other host must not reach it.
const ROUTE_HOST = {
  [ACTIVITY_PATH]: WORKFORCE_HOST,
  [DESK_MODE_PATH]: WORKFORCE_HOST,
  [CAMPAIGN_RESPONSES_PATH]: COMMS_HOST,
};

// Stub authenticate: the test identity arrives in the x-test-user header. No header means refused.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  next();
};
// Stub role guard: admin or manager only, as the real requireRole('admin', 'manager') is.
const stubRequireApprover = (req, res, next) => {
  if (req.user && ['admin', 'manager'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};
const guards = { authenticate: stubAuthenticate, requireCompanyScope: requireCompanyScope(), requireApprover: stubRequireApprover };

async function start(deps) {
  const app = express();
  app.use(express.json());
  app.use(createCockpitRouter(deps, guards));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
    call: ({ method = 'GET', path, user = null, host, headers = {}, body }) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const h = { host: host ?? ROUTE_HOST[path.split('?')[0]] ?? WORKFORCE_HOST, ...headers };
        if (user) h['x-test-user'] = JSON.stringify(user);
        if (payload !== undefined) {
          h['content-type'] = 'application/json';
          h['content-length'] = Buffer.byteLength(payload);
        }
        const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
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

test('unauthenticated requests are refused on every route and nothing is loaded', async () => {
  let loads = 0;
  const srv = await start({ loadApprovals: () => { loads += 1; return []; } });
  try {
    for (const path of [ACTIVITY_PATH, CAMPAIGN_RESPONSES_PATH]) {
      const res = await srv.call({ path, user: null });
      assert.equal(res.status, 401, `${path} should refuse without login`);
    }
    const desk = await srv.call({ path: DESK_MODE_PATH, user: null });
    assert.equal(desk.status, 401, 'desk-mode should refuse without login');
    assert.equal(loads, 0);
  } finally {
    await srv.close();
  }
});

test('a logged-in user with no company is refused with 403 on every route', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    for (const path of [ACTIVITY_PATH, DESK_MODE_PATH, CAMPAIGN_RESPONSES_PATH]) {
      const res = await srv.call({ path, user: USER_NO_COMPANY });
      assert.equal(res.status, 403, `${path} should fail closed without a company`);
    }
  } finally {
    await srv.close();
  }
});

test('desk-mode returns the comms mode from the Host header on the comms host, with source host', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const res = await srv.call({ path: DESK_MODE_PATH, user: USER_A, host: COMMS_HOST });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { mode: 'comms', source: 'host' });
  } finally {
    await srv.close();
  }
});

test('desk-mode refuses unrecognised hosts', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const res = await srv.call({ path: DESK_MODE_PATH, user: USER_A, host: UNKNOWN_HOST });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    await srv.close();
  }
});

test('desk-mode ignores X-Forwarded-Host: a client cannot claim the comms mode from the workforce host', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const res = await srv.call({
      path: DESK_MODE_PATH,
      user: USER_A,
      host: WORKFORCE_HOST,
      headers: { 'x-forwarded-host': COMMS_HOST },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { mode: 'workforce', source: 'host' });
  } finally {
    await srv.close();
  }
});

test('session mode helper and host resolver agree on the two Desk hosts and fail closed to workforce', () => {
  assert.deepEqual(resolveDeskMode(WORKFORCE_HOST, DEFAULT_MODE_CONFIG), { ok: true, mode: 'workforce', host: WORKFORCE_HOST });
  assert.deepEqual(resolveDeskMode(COMMS_HOST, DEFAULT_MODE_CONFIG), { ok: true, mode: 'comms', host: COMMS_HOST });
  assert.equal(resolveDeskMode(undefined, DEFAULT_MODE_CONFIG).ok, false);
  assert.equal(resolveDeskMode(UNKNOWN_HOST, DEFAULT_MODE_CONFIG).ok, false);
  assert.deepEqual(sessionDeskMode(COMMS_HOST), { mode: 'comms', source: 'host' });
  assert.deepEqual(sessionDeskMode(UNKNOWN_HOST), { mode: 'workforce', source: 'default' });
  assert.deepEqual(sessionDeskMode(undefined), { mode: 'workforce', source: 'default' });
  assert.deepEqual(sessionDeskMode(['syncedat.work', 'superchargedat.work']), { mode: 'workforce', source: 'default' });
});

test('the campaign responses feed is refused on the workforce host, even when logged in', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const res = await srv.call({ path: CAMPAIGN_RESPONSES_PATH, user: USER_A, host: WORKFORCE_HOST });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    await srv.close();
  }
});

test('the campaign responses feed is refused on an unknown host and no comms code runs', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const res = await srv.call({ path: CAMPAIGN_RESPONSES_PATH, user: USER_A, host: UNKNOWN_HOST });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test('the campaign responses feed on the comms host still needs login and company scope', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const anon = await srv.call({ path: CAMPAIGN_RESPONSES_PATH, user: null, host: COMMS_HOST });
    assert.equal(anon.status, 401);
    const noCompany = await srv.call({ path: CAMPAIGN_RESPONSES_PATH, user: USER_NO_COMPANY, host: COMMS_HOST });
    assert.equal(noCompany.status, 403);
  } finally {
    await srv.close();
  }
});

test('the activity feed is refused on the comms host and loads nothing', async () => {
  let loaded = false;
  const srv = await start({
    loadApprovals: () => {
      loaded = true;
      return [];
    },
  });
  try {
    const res = await srv.call({ path: ACTIVITY_PATH, user: USER_A, host: COMMS_HOST });
    assert.equal(res.status, 404);
    assert.equal(loaded, false);
  } finally {
    await srv.close();
  }
});

test('the campaign responses feed works on the comms host and returns an empty list with eventsSource none', async () => {
  const srv = await start({ loadApprovals: () => [] });
  try {
    const res = await srv.call({ path: CAMPAIGN_RESPONSES_PATH, user: USER_A, host: COMMS_HOST });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [], eventsSource: 'none' });
  } finally {
    await srv.close();
  }
});

test('the activity route refuses a plain member, because it lists pending approvals', async () => {
  let loaded = false;
  const srv = await start({
    loadApprovals: () => {
      loaded = true;
      return [];
    },
  });
  try {
    const res = await srv.call({ path: ACTIVITY_PATH, user: { userId: 'u-m', role: 'member', companyId: CO_A } });
    assert.equal(res.status, 403);
    assert.equal(loaded, false);
  } finally {
    await srv.close();
  }
});

test('the activity route passes only the caller company and returns only that company items', async () => {
  const seen = [];
  const approvals = [
    { id: 'a-1', companyId: CO_A, status: 'pending', action: 'send_invoice', requestedAt: '2026-11-01T10:00:00Z' },
    { id: 'b-1', companyId: CO_B, status: 'pending', action: 'send_invoice', requestedAt: '2026-11-01T11:00:00Z' },
  ];
  const srv = await start({
    loadApprovals: (companyId) => {
      seen.push(companyId);
      return approvals;
    },
  });
  try {
    // A company id in the query or body must not change the tenant.
    const res = await srv.call({ path: `${ACTIVITY_PATH}?companyId=${CO_B}`, user: USER_A });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [CO_A]);
    assert.equal(res.body.runsSource, 'none');
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].kind, 'needs_approval');
    assert.equal(res.body.items[0].id, 'needs_approval:a-1');
    assert.ok(!JSON.stringify(res.body).includes(CO_B));
  } finally {
    await srv.close();
  }
});

test('the cockpit router is mounted in server/routes/core/workforce-comms-routes.ts with authentication, company scope and the approver role guard', () => {
  const source = readFileSync(new URL('../../server/routes/core/workforce-comms-routes.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*\bcreateCockpitRouter\b[^}]*\} from "\.\.\/\.\.\/routes\/cockpit-routes";/);
  assert.match(source, /app\.use\(createCockpitRouter\(\{\}, \{ authenticate: authenticateToken as unknown as import\('express'\)\.RequestHandler, requireCompanyScope: requireCompanyScope\(\), requireApprover: requireRole\("admin", "manager"\) as unknown as import\('express'\)\.RequestHandler \}\)\);/);
});
