// Immediate waiter notification on approval decisions. Runs the real ApprovalService and the real
// approval route with fakes only: no database, no network.
//
// Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/modules/approval-waiter-notify.test.mjs

// Test files must not write to stdout (the test runner's IPC breaks). Silence the console first.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

globalThis.__auditEvents = [];
const AUDIT_STUB = 'export async function logAuditEvent(entry) { globalThis.__auditEvents.push(entry); }';
const AUTH_STUB = 'export function requireRole() { return (req, res, next) => next(); }';
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
  data: {
    stubs: [
      ['/services/audit-log', AUDIT_STUB],
      ['/middleware/auth', AUTH_STUB],
    ],
  },
});

const { ApprovalService } = await import('../../server/modules/approvals/approval-service.ts');
const { createApprovalRouter } = await import('../../server/modules/approvals/approval-routes.ts');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const APPROVAL_ID = 'ap-1';
const MESSAGE_ID = 'msg-1';
const LONG_TTL_MS = 60_000;

function makeService() {
  return new ApprovalService({ tenant: { run: async (_companyId, fn) => fn({}) } });
}

test('a waiter resolves with the decision as soon as it is notified, long before its timeout', async () => {
  const service = makeService();
  const started = Date.now();
  const waiting = service.waitForDecision(TENANT, APPROVAL_ID, LONG_TTL_MS);
  service.notifyDecision(TENANT, APPROVAL_ID, 'approved');
  assert.equal(await waiting, 'approved');
  assert.ok(Date.now() - started < LONG_TTL_MS / 10, 'waiter must not wait for its timeout');
});

test('a notification for another company does not wake this tenant\'s waiter', async () => {
  const service = makeService();
  const waiting = service.waitForDecision(TENANT, 'ap-2', LONG_TTL_MS);
  let settled = false;
  waiting.then(() => { settled = true; });
  service.notifyDecision(OTHER_TENANT, 'ap-2', 'approved');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  service.notifyDecision(TENANT, 'ap-2', 'rejected');
  assert.equal(await waiting, 'rejected');
});

test('notifying an approval with no waiter is a no-op', () => {
  const service = makeService();
  assert.doesNotThrow(() => service.notifyDecision(TENANT, 'ap-none', 'approved'));
});

describe('approve route with a failing notify', () => {
  let server;
  let base;
  const errors = [];
  const originalError = console.error;

  const PENDING = { id: APPROVAL_ID, status: 'pending', action: 'send', params: { messageId: MESSAGE_ID } };
  const service = {
    getApproval: async () => ({ ...PENDING, status: 'approved' }),
    decideApproval: async () => null,
    listApprovals: async () => [],
    listRules: async () => [],
    notifyDecision: () => { throw new Error('notify boom'); },
  };
  const transactions = {
    runInTransaction: async (callback) => callback({
      writeApprovalDecision: async () => true,
      writeMessageStatus: async () => true,
    }),
  };

  before(async () => {
    console.error = (...args) => { errors.push(args); };
    const app = express();
    app.use(express.json());
    app.use('/api/approvals', (req, res, next) => {
      res.locals = { companyId: TENANT };
      req.userId = 'u1';
      next();
    });
    app.use('/api/approvals', createApprovalRouter(service, {
      transactionsFor: () => transactions,
    }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/approvals`;
  });

  after(async () => {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  });

  test('a notify failure is logged, the audit event is still written, and the response is 200', async () => {
    errors.length = 0;
    globalThis.__auditEvents.length = 0;
    const res = await fetch(`${base}/${APPROVAL_ID}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'ok' }),
    });
    assert.equal(res.status, 200);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /\[Approvals\]/);
    const audit = globalThis.__auditEvents.find((e) => e.action === 'approval.approved');
    assert.ok(audit, 'audit event must be written');
    assert.equal(audit.resourceId, APPROVAL_ID);
    assert.equal(audit.metadata.companyId, TENANT);
  });
});
