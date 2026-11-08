import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Documents how the rate limiter keys requests today, using real HTTP requests
// on an ephemeral port. Linux routes all of 127.0.0.0/8 to loopback, so each
// test binds its client to a distinct 127.0.0.x source address to act as a
// separate client. Each test uses its own addresses because the limiter store
// is module-global.
const { apiRateLimiter, authRateLimiter } =
  await import('../../server/middleware/rateLimiter.ts');

function startApp(limiter) {
  const app = express();
  app.set('etag', false);
  app.get('/', limiter, (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function get(port, { localAddress, xff } = {}) {
  const headers = { connection: 'close' };
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers, agent: false, localAddress },
      (res) => {
        res.resume();
        res.on('end', () => resolve({
          status: res.statusCode,
          limit: res.headers['x-ratelimit-limit'],
          remaining: res.headers['x-ratelimit-remaining'] === undefined
            ? undefined
            : Number(res.headers['x-ratelimit-remaining']),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('apiRateLimiter: two clients sending the same X-Forwarded-For do NOT share a bucket (key is the socket address)', async () => {
  const { server, port } = await startApp(apiRateLimiter);
  try {
    const xff = '203.0.113.7';
    const a1 = await get(port, { localAddress: '127.0.0.31', xff });
    const a2 = await get(port, { localAddress: '127.0.0.31', xff });
    const b1 = await get(port, { localAddress: '127.0.0.32', xff });

    assert.equal(a1.remaining, 59);
    assert.equal(a2.remaining, 58);
    // Client B is on its own bucket: a shared bucket would report 57 here.
    assert.equal(b1.remaining, 59);
  } finally {
    server.close();
  }
});

test('apiRateLimiter: two clients on the same socket address share a bucket even with different X-Forwarded-For values', async () => {
  const { server, port } = await startApp(apiRateLimiter);
  try {
    const first = await get(port, { localAddress: '127.0.0.41', xff: '198.51.100.1' });
    const second = await get(port, { localAddress: '127.0.0.41', xff: '198.51.100.2' });

    assert.equal(first.remaining, 59);
    assert.equal(second.remaining, 58);
  } finally {
    server.close();
  }
});

test('apiRateLimiter: a client that forges X-Forwarded-For does NOT change its bucket key (key is req.ip only, the raw header is never read)', async () => {
  const { server, port } = await startApp(apiRateLimiter);
  try {
    const r1 = await get(port, { localAddress: '127.0.0.51', xff: '10.0.0.1' });
    const r2 = await get(port, { localAddress: '127.0.0.51', xff: '10.0.0.2' });
    const r3 = await get(port, { localAddress: '127.0.0.51', xff: '10.0.0.3' });

    // Same bucket on every request: remaining counts down 59, 58, 57.
    assert.deepEqual([r1.remaining, r2.remaining, r3.remaining], [59, 58, 57]);
  } finally {
    server.close();
  }
});

test('authRateLimiter: a client that forges X-Forwarded-For does NOT change its bucket key (key is req.ip only, the raw header is never read)', async () => {
  const { server, port } = await startApp(authRateLimiter);
  try {
    const r1 = await get(port, { localAddress: '127.0.0.61', xff: '10.1.0.1' });
    const r2 = await get(port, { localAddress: '127.0.0.61', xff: '10.1.0.2' });
    const r3 = await get(port, { localAddress: '127.0.0.61', xff: '10.1.0.3' });

    // authRateLimiter allows 10 per window, so counts go 9, 8, 7.
    assert.deepEqual([r1.remaining, r2.remaining, r3.remaining], [9, 8, 7]);
  } finally {
    server.close();
  }
});
