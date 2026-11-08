// Approval decision route: approve and reject go through applyApprovalDecision with an
// injected, tenant-bound transaction runner. Fakes only: no database, no network.

const SILENT = () => {};
console.log = SILENT;
console.info = SILENT;
console.warn = SILENT;

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import express from 'express';

const AUDIT_STUB = 'export async function logAuditEvent() {}';
const AUTH_STUB = `
export function requireRole() { return (req, res, next) => next(); }
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
  data: {
    stubs: [
      ['/services/audit-log', AUDIT_STUB],
      ['/middleware/auth', AUTH_STUB],
    ],
  },
});

const { createApprovalRouter } = await import('../../server/modules/approvals/approval-routes.ts');

const TENANT = '11111111-1111-4111-8111-111111111111';
const ATTACKER = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = 'ap-1';
const MESSAGE_ID = 'msg-1';

/** Fake approval service. getApproval returns the row set per test; decideApproval must never be called. */
function makeService(calls, row) {
  return {
    getApproval: async (companyId, id) => {
      calls.push({ name: 'getApproval', companyId, id });
      return row.current ? { ...row.current } : null;
    },
    decideApproval: async (...args) => { calls.push({ name: 'decideApproval', args }); return null; },
    notifyDecision: (companyId, id, status) => { calls.push({ name: 'notifyDecision', companyId, id, status }); },
    listApprovals: async () => [],
    listRules: async () => [],
  };
}

/**
 * Fake transaction runner. writeApprovalDecision and writeMessageStatus return the scripted
 * results. A false result or a throw rolls back, as the real runner must.
 */
function makeTransactions(calls, script) {
  return {
    runInTransaction: async (callback) => {
      calls.push({ name: 'runInTransaction' });
      const tx = {
        writeApprovalDecision: async (w) => { calls.push({ name: 'writeApprovalDecision', w }); return script.approvalWrite; },
        writeMessageStatus: async (w) => { calls.push({ name: 'writeMessageStatus', w }); return script.messageWrite; },
      };
      return callback(tx);
    },
  };
}

describe('approval decision route', () => {
  let server;
  let base;
  let calls;
  let row;
  let script;
  let factoryCompanies;
  let withRunner;

  function buildApp(deps) {
    const app = express();
    app.use(express.json());
    app.use('/api/approvals', (req, res, next) => {
      res.locals = res.locals ?? {};
      res.locals.companyId = TENANT;
      req.user = { id: 'u1', role: 'admin', companyId: ATTACKER };
      req.userId = 'u1';
      next();
    });
    app.use('/api/approvals', createApprovalRouter(makeService(calls, row), deps));
    return app;
  }

  before(async () => {
    calls = [];
    row = {};
    script = {};
    factoryCompanies = [];
    withRunner = {
      transactionsFor: (companyId) => {
        factoryCompanies.push(companyId);
        return makeTransactions(calls, script);
      },
    };
    const app = buildApp(withRunner);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/approvals`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function reset(current, scripted) {
    calls.length = 0;
    factoryCompanies.length = 0;
    row.current = current;
    Object.assign(script, { approvalWrite: true, messageWrite: true }, scripted);
  }

  function post(action, body = { reason: 'ok' }) {
    return fetch(`${base}/${APPROVAL_ID}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const PENDING = { id: APPROVAL_ID, status: 'pending', params: { messageId: MESSAGE_ID } };

  test('approve applies the approval and message write in one transaction, bound to the verified company', async () => {
    reset({ ...PENDING, status: 'approved' });
    const res = await post('approve', { companyId: ATTACKER, reason: 'ok' });
    assert.equal(res.status, 200);
    assert.deepEqual(factoryCompanies, [TENANT]);
    const approvalWrite = calls.find((c) => c.name === 'writeApprovalDecision');
    const messageWrite = calls.find((c) => c.name === 'writeMessageStatus');
    assert.equal(approvalWrite.w.companyId, TENANT);
    assert.equal(approvalWrite.w.decision, 'approved');
    assert.equal(approvalWrite.w.decidedBy, 'dashboard:u1');
    assert.equal(messageWrite.w.messageId, MESSAGE_ID);
    assert.equal(messageWrite.w.nextStatus, 'queued');
    assert.equal(calls.some((c) => c.name === 'decideApproval'), false);
    const notified = calls.find((c) => c.name === 'notifyDecision');
    assert.deepEqual(notified, { name: 'notifyDecision', companyId: TENANT, id: APPROVAL_ID, status: 'approved' });
  });

  test('reject maps to a skipped message with approval_rejected', async () => {
    reset({ ...PENDING, status: 'rejected' });
    const res = await post('reject');
    assert.equal(res.status, 200);
    const messageWrite = calls.find((c) => c.name === 'writeMessageStatus');
    assert.equal(messageWrite.w.nextStatus, 'skipped');
    assert.equal(messageWrite.w.skipReason, 'approval_rejected');
  });

  test('approval_not_pending returns 409 with the current status', async () => {
    reset({ ...PENDING, status: 'approved' }, { approvalWrite: false });
    const res = await post('approve');
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.status, 'approved');
    assert.equal(calls.some((c) => c.name === 'writeMessageStatus'), false);
  });

  test('message_not_awaiting returns 409 and the approval write is rolled back by the runner', async () => {
    reset(PENDING, { messageWrite: false });
    const res = await post('approve');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'Message is no longer awaiting approval');
    assert.equal(calls.filter((c) => c.name === 'writeApprovalDecision').length, 1);
  });

  test('an approval with no linked message is refused with 409 before any transaction opens', async () => {
    reset({ id: APPROVAL_ID, status: 'pending', params: {} });
    const res = await post('approve');
    assert.equal(res.status, 409);
    assert.equal(calls.some((c) => c.name === 'runInTransaction'), false);
  });

  test('unknown approval returns 404 without opening a transaction', async () => {
    reset(null);
    const res = await post('reject');
    assert.equal(res.status, 404);
    assert.equal(calls.some((c) => c.name === 'runInTransaction'), false);
  });

  test('fails closed with 503 when no transaction runner is injected', async () => {
    const calls2 = [];
    const app = express();
    app.use(express.json());
    app.use('/api/approvals', (req, res, next) => {
      res.locals = { companyId: TENANT };
      req.userId = 'u1';
      next();
    });
    app.use('/api/approvals', createApprovalRouter(makeService(calls2, { current: PENDING })));
    const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/approvals/${APPROVAL_ID}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 503);
      assert.equal(calls2.some((c) => c.name === 'decideApproval'), false);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});
