/**
 * Auth coverage for the user SIP gateway and phone-number routes in server/routes/user-sip-gateways.routes.ts.
 *
 * The guard is held in a variable (`const auth = authenticateToken ...`), which the static route-auth scanner
 * recognises only when it is passed as a route argument. These tests check the behaviour directly:
 *   - no bearer token: 401 on every route, before any handler or database call runs
 *   - a token that does not verify: 403 on every route, before any handler or database call runs
 *   - every route in the file passes the auth middleware as its second argument
 *
 * Not covered: cross-tenant reads and writes (needs a database fixture); those stay open under issue #320.
 *
 * Run: node --test --experimental-transform-types tests/security/user-sip-gateways-route-auth.test.mjs
 */
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';
import { register } from 'node:module';

// The route file imports ../db. Replace it with a stub that fails the test if any handler reaches the database.
const DB_STUB = `
export const db = {
  execute: async () => { throw new Error('database must not be reached before auth'); },
};
`;
const HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let stubs = [];
export function initialize(data) { stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.')) {
    const hit = stubs.find(([suffix]) => specifier.endsWith(suffix));
    if (hit) {
      return { url: 'data:text/javascript,' + encodeURIComponent(hit[1]), format: 'module', shortCircuit: true };
    }
    if (!/\\.[cm]?[jt]s$/.test(specifier)) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url, {
  data: { stubs: [['/db', DB_STUB]] },
});

const { createUserSipGatewaysRoutes } = await import('../../server/routes/user-sip-gateways.routes.ts');

const SRC = fs.readFileSync(new URL('../../server/routes/user-sip-gateways.routes.ts', import.meta.url), 'utf8');

const ROUTES = [
  ['GET', '/api/user/sip-gateways'],
  ['POST', '/api/user/sip-gateways'],
  ['PUT', '/api/user/sip-gateways/00000000-0000-4000-8000-000000000001'],
  ['DELETE', '/api/user/sip-gateways/00000000-0000-4000-8000-000000000001'],
  ['POST', '/api/user/sip-gateways/00000000-0000-4000-8000-000000000001/activate'],
  ['GET', '/api/user/sip-phone-numbers'],
  ['POST', '/api/user/sip-phone-numbers'],
  ['PUT', '/api/user/sip-phone-numbers/00000000-0000-4000-8000-000000000001'],
  ['DELETE', '/api/user/sip-phone-numbers/00000000-0000-4000-8000-000000000001'],
];

function startApp() {
  const app = express();
  app.use(express.json());
  app.use(createUserSipGatewaysRoutes());
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function call(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('every user SIP gateway and phone-number route passes the auth middleware', () => {
  const routeLines = SRC.split('\n').filter((l) => /^\s*router\.(get|post|put|delete)\(/.test(l));
  assert.equal(routeLines.length, ROUTES.length, 'route count changed; update ROUTES in this test');
  for (const line of routeLines) {
    assert.match(line, /,\s*auth,/, `auth middleware missing on: ${line.trim()}`);
  }
});

test('no bearer token is refused with 401 on every SIP route', async () => {
  const server = await startApp();
  try {
    const { port } = server.address();
    for (const [method, path] of ROUTES) {
      const res = await call(port, method, path);
      assert.equal(res.status, 401, `${method} ${path} should be 401`);
    }
  } finally {
    server.close();
  }
});

test('a token that does not verify is refused with 403 on every SIP route', async () => {
  const server = await startApp();
  try {
    const { port } = server.address();
    for (const [method, path] of ROUTES) {
      const res = await call(port, method, path, { authorization: 'Bearer not-a-real-token' });
      assert.equal(res.status, 403, `${method} ${path} should be 403`);
    }
  } finally {
    server.close();
  }
});
