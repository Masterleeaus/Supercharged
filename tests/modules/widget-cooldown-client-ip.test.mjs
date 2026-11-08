// public-widget-routes computes the cooldown key as
//   const visitorIp = req.ip || req.socket.remoteAddress || '';
//   cleanedIp = typeof visitorIp === 'string' ? visitorIp.trim() : '';
// and passes it to widgetService.checkCooldown(widget.id, cleanedIp).
// The widget router imports the database, storage and engine modules, so it is not
// loaded here. This file mirrors the IP derivation in a minimal Express app and uses an
// in-memory cooldown stub keyed by the same value. Keep it in step with public-widget-routes.ts.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { resolveTrustProxy } from '../../server/middleware/trust-proxy.ts';

function startApp(trustProxy, cooldownSeen) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.post('/widgets/:id/start', (req, res) => {
    const visitorIp = req.ip || req.socket.remoteAddress || '';
    const cleanedIp = typeof visitorIp === 'string' ? visitorIp.trim() : '';
    // Stub for widgetService.checkCooldown(widgetId, visitorIp): one call per IP per widget.
    const key = `${req.params.id}:${cleanedIp}`;
    if (cooldownSeen.has(key)) {
      return res.status(429).json({ error: 'Cooldown period active', key: cleanedIp });
    }
    cooldownSeen.add(key);
    return res.json({ ok: true, key: cleanedIp });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function post(port, xff) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close', 'content-type': 'application/json' };
    if (xff !== undefined) headers['x-forwarded-for'] = xff;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/widgets/w1/start', method: 'POST', headers, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('public widget cooldown uses the real visitor address', () => {
  test('two requests from one address share a cooldown despite different spoofed X-Forwarded-For', async () => {
    const seen = new Set();
    const { server, port } = await startApp(resolveTrustProxy(undefined), seen);
    try {
      const first = await post(port, '203.0.113.1');
      assert.equal(first.status, 200);
      const second = await post(port, '203.0.113.2');
      assert.equal(second.status, 429);
      assert.equal(second.body.error, 'Cooldown period active');
      assert.match(second.body.key, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    } finally {
      server.close();
    }
  });

  test('X-Forwarded-For does not give a visitor a fresh cooldown bucket', async () => {
    const seen = new Set();
    const { server, port } = await startApp(resolveTrustProxy(undefined), seen);
    try {
      await post(port, '203.0.113.10');
      const retry = await post(port, '203.0.113.11');
      assert.equal(retry.status, 429);
    } finally {
      server.close();
    }
  });
});
