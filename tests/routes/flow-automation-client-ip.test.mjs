// flow-automation-routes POST /flows/:id/test derives clientIp as
//   String(req.ip || req.socket.remoteAddress || 'unknown')
// and passes it to checkDemoCallLimit / logDemoCall. The route module imports the
// database and most of the app, so it cannot be loaded cleanly in a test. This file
// mirrors that one expression in a minimal Express app and records the key the
// demo-limit stub receives. Keep it in step with the line in flow-automation-routes.ts.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { resolveTrustProxy } from '../../server/middleware/trust-proxy.ts';

function startApp(trustProxy, demoKeys) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.post('/flows/:id/test', (req, res) => {
    const clientIp = String(req.ip || req.socket.remoteAddress || 'unknown');
    // Stub for checkDemoCallLimit(userId, clientIp): records the key it was given.
    demoKeys.push(clientIp);
    res.json({ clientIp });
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
      { host: '127.0.0.1', port, path: '/flows/f1/test', method: 'POST', headers, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('flow-automation test-call clientIp', () => {
  test('spoofed X-Forwarded-For does not change the demo-limit key when trust proxy is off', async () => {
    const keys = [];
    const { server, port } = await startApp(resolveTrustProxy(undefined), keys);
    try {
      const first = await post(port, '203.0.113.9');
      const second = await post(port, '198.51.100.77');
      assert.notEqual(first.clientIp, '203.0.113.9');
      assert.notEqual(first.clientIp, '198.51.100.77');
      assert.match(first.clientIp, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
      assert.equal(first.clientIp, second.clientIp);
      assert.deepEqual(keys, [first.clientIp, second.clientIp]);
    } finally {
      server.close();
    }
  });

  test('X-Forwarded-For is used for the key only when the operator opts in with TRUST_PROXY', async () => {
    const keys = [];
    const { server, port } = await startApp(resolveTrustProxy('1'), keys);
    try {
      const { clientIp } = await post(port, '203.0.113.9');
      assert.equal(clientIp, '203.0.113.9');
    } finally {
      server.close();
    }
  });
});
