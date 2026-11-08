// audit-log extractRequestInfo must take the client address from req.ip, so a
// spoofed X-Forwarded-For cannot change the recorded IP while trust proxy is off.
//
// audit-log.ts opens the app DB pool on import, so the DB module and the schema
// are swapped for stubs with a loader hook (same approach as approvals-resubmit-guard).

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { register } from 'node:module';
import express from 'express';

const HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier) && specifier !== '../db') {
    for (const candidate of [specifier + '.ts', specifier + '.mjs', specifier + '/index.ts']) {
      const url = new URL(candidate, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  if (specifier === '@shared/schema') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export const auditLogs = {};'), format: 'module', shortCircuit: true };
  }
  if (specifier === '../db' || specifier.endsWith('/db')) {
    return { url: 'data:text/javascript,' + encodeURIComponent('export const db = {};'), format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url);

const { extractRequestInfo } = await import('../../server/services/audit-log.ts');
const { resolveTrustProxy } = await import('../../server/middleware/trust-proxy.ts');

function startApp(trustProxy) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', (req, res) => res.json(extractRequestInfo(req)));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, xff) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { connection: 'close', 'x-forwarded-for': xff }, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('audit-log extractRequestInfo client IP', () => {
  test('spoofed X-Forwarded-For does not change the recorded IP when trust proxy is off', async () => {
    const { server, port } = await startApp(resolveTrustProxy(undefined));
    try {
      const { ipAddress } = await get(port, '203.0.113.9');
      assert.notEqual(ipAddress, '203.0.113.9');
      assert.match(ipAddress, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    } finally {
      server.close();
    }
  });

  test('X-Forwarded-For is honoured only when the operator opts in with TRUST_PROXY', async () => {
    const { server, port } = await startApp(resolveTrustProxy('1'));
    try {
      const { ipAddress } = await get(port, '203.0.113.9');
      assert.equal(ipAddress, '203.0.113.9');
    } finally {
      server.close();
    }
  });
});
