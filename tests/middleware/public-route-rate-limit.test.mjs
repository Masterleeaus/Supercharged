import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const {
  createPublicRouteRateLimit,
  classifyPublicRoute,
  readPublicRateLimitConfig,
  PUBLIC_RATE_LIMIT_DEFAULTS,
} = await import('../../server/middleware/public-route-rate-limit.ts');

const CONFIG = { ...PUBLIC_RATE_LIMIT_DEFAULTS };

// Each test builds its own app and limiter, so counters never leak between tests.
// Linux routes all of 127.0.0.0/8 to loopback, so each client binds to its own
// 127.0.0.x source address to look like a separate IP.
function startApp(overrides = {}, clock) {
  const app = express();
  app.set('trust proxy', false);
  app.use(createPublicRouteRateLimit({ ...CONFIG, ...overrides }, clock));
  app.all('*', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function hit(port, path, { localAddress, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { connection: 'close', ...headers }, agent: false, localAddress },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('auth route: the 11th request from one IP gets 429 with Retry-After', async () => {
  const { server, port } = await startApp();
  try {
    const ip = { localAddress: '127.0.0.41' };
    for (let i = 0; i < 10; i++) {
      assert.equal((await hit(port, '/api/auth/login', ip)).status, 200);
    }
    const refused = await hit(port, '/api/auth/login', ip);
    assert.equal(refused.status, 429);
    const retryAfter = Number(refused.retryAfter);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After was ${refused.retryAfter}`);
  } finally {
    server.close();
  }
});

test('public route: the 61st request from one IP gets 429 with Retry-After', async () => {
  const { server, port } = await startApp();
  try {
    const ip = { localAddress: '127.0.0.42' };
    for (let i = 0; i < 60; i++) {
      assert.equal((await hit(port, '/api/branding', ip)).status, 200);
    }
    const refused = await hit(port, '/api/branding', ip);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.retryAfter) >= 1);
  } finally {
    server.close();
  }
});

test('per-IP isolation: one client exhausting the limit does not block another IP', async () => {
  const { server, port } = await startApp();
  try {
    const a = { localAddress: '127.0.0.43' };
    const b = { localAddress: '127.0.0.44' };
    for (let i = 0; i < 10; i++) await hit(port, '/api/auth/login', a);
    assert.equal((await hit(port, '/api/auth/login', a)).status, 429);
    assert.equal((await hit(port, '/api/auth/login', b)).status, 200);
  } finally {
    server.close();
  }
});

test('forged X-Forwarded-For does not pick a new bucket when trust proxy is off', async () => {
  const { server, port } = await startApp();
  try {
    const ip = { localAddress: '127.0.0.45' };
    for (let i = 0; i < 10; i++) {
      await hit(port, '/api/auth/login', { ...ip, headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    }
    const refused = await hit(port, '/api/auth/login', { ...ip, headers: { 'x-forwarded-for': '203.0.113.99' } });
    assert.equal(refused.status, 429);
  } finally {
    server.close();
  }
});

test('webhook exemption: provider webhook paths are never limited, even past the public threshold', async () => {
  const { server, port } = await startApp({ publicMax: 2, authMax: 2 });
  try {
    const ip = { localAddress: '127.0.0.46' };
    const webhookPaths = [
      '/api/webhooks/twilio/voice',
      '/api/webhooks/elevenlabs',
      '/api/stripe/webhook',
      '/api/elevenlabs-webhooks/verify',
      '/api/chatbot/channels/11111111-2222-4333-8444-555555555555/telegram/webhook/acct-1',
    ];
    for (const path of webhookPaths) {
      for (let i = 0; i < 5; i++) {
        assert.equal((await hit(port, path, ip)).status, 200, `${path} request ${i + 1}`);
      }
    }
  } finally {
    server.close();
  }
});

test('health exemption: /api/health is never limited', async () => {
  const { server, port } = await startApp({ publicMax: 1 });
  try {
    const ip = { localAddress: '127.0.0.47' };
    for (let i = 0; i < 5; i++) {
      assert.equal((await hit(port, '/api/health', ip)).status, 200);
    }
  } finally {
    server.close();
  }
});

test('auth and public buckets are counted separately for the same IP', async () => {
  const { server, port } = await startApp({ authMax: 1, publicMax: 3 });
  try {
    const ip = { localAddress: '127.0.0.48' };
    assert.equal((await hit(port, '/api/auth/login', ip)).status, 200);
    assert.equal((await hit(port, '/api/auth/login', ip)).status, 429);
    assert.equal((await hit(port, '/api/branding', ip)).status, 200);
  } finally {
    server.close();
  }
});

test('unlisted routes are not limited by this middleware', async () => {
  const { server, port } = await startApp({ authMax: 1, publicMax: 1 });
  try {
    const ip = { localAddress: '127.0.0.49' };
    for (let i = 0; i < 5; i++) {
      assert.equal((await hit(port, '/api/agents', ip)).status, 200);
    }
  } finally {
    server.close();
  }
});

test('window reset: a refused client is allowed again after the window', async () => {
  let t = 1_000_000;
  const clock = () => t;
  const { server, port } = await startApp({ authMax: 2, authWindowMs: 60_000 }, clock);
  try {
    const ip = { localAddress: '127.0.0.50' };
    await hit(port, '/api/auth/login', ip);
    await hit(port, '/api/auth/login', ip);
    assert.equal((await hit(port, '/api/auth/login', ip)).status, 429);
    t += 60_000;
    assert.equal((await hit(port, '/api/auth/login', ip)).status, 200);
  } finally {
    server.close();
  }
});

test('path matching ignores case and a trailing slash', () => {
  assert.equal(classifyPublicRoute('/API/AUTH/LOGIN'), 'auth');
  assert.equal(classifyPublicRoute('/api/auth/login/'), 'auth');
  assert.equal(classifyPublicRoute('/api/auth/forgot-password/send-otp'), 'auth');
  assert.equal(classifyPublicRoute('/api/auth/me'), null);
  assert.equal(classifyPublicRoute('/api/loginx'), null);
  assert.equal(classifyPublicRoute('/api/publicity'), null);
  assert.equal(classifyPublicRoute('/api/public/seo'), 'public');
  assert.equal(classifyPublicRoute('/api/webhooks/twilio/voice'), 'exempt');
  assert.equal(classifyPublicRoute('/api/health'), 'exempt');
});

test('readPublicRateLimitConfig: defaults, overrides and invalid values', () => {
  assert.deepEqual(readPublicRateLimitConfig({}), {
    enabled: true, authMax: 10, authWindowMs: 60000, publicMax: 60, publicWindowMs: 60000, maxBuckets: 10000,
  });
  const cfg = readPublicRateLimitConfig({
    RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_AUTH_MAX: '5', RATE_LIMIT_PUBLIC_MAX: 'abc', RATE_LIMIT_AUTH_WINDOW_MS: '-1',
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.authMax, 5);
  assert.equal(cfg.publicMax, 60);
  assert.equal(cfg.authWindowMs, 60000);
});

test('RATE_LIMIT_ENABLED=false turns the limiter off', async () => {
  const { server, port } = await startApp({ enabled: false, authMax: 1 });
  try {
    const ip = { localAddress: '127.0.0.51' };
    for (let i = 0; i < 3; i++) {
      assert.equal((await hit(port, '/api/auth/login', ip)).status, 200);
    }
  } finally {
    server.close();
  }
});
