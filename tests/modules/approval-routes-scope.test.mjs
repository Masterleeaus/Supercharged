// Approval routes company scope: the tenant comes only from res.locals.companyId.
// Body, query and params must never choose the company. No database is used:
// the service is a recording stub, and auth and audit logging are replaced.

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
const APPROVAL_ID = 'abc-123';

// Writes made through the decision runner, so the test can see which company each one was scoped to.
const decisionWrites = { scopes: [], approval: [], message: [] };
function resetDecisionWrites() {
  decisionWrites.scopes.length = 0;
  decisionWrites.approval.length = 0;
  decisionWrites.message.length = 0;
}

// Injected decision runner: a transaction handle whose two writes always apply.
const decisionDeps = {
  transactionsFor: (companyId) => {
    decisionWrites.scopes.push(companyId);
    return {
      runInTransaction: async (callback) => callback({
        writeApprovalDecision: async (write) => { decisionWrites.approval.push(write); return true; },
        writeMessageStatus: async (write) => { decisionWrites.message.push(write); return true; },
      }),
    };
  },
};

function makeService(calls) {
  const record = (name) => async (companyId, ...rest) => {
    calls.push({ name, companyId, rest });
    return { id: APPROVAL_ID, status: 'approved' };
  };
  return {
    listApprovals: async (companyId, opts) => { calls.push({ name: 'listApprovals', companyId, rest: [opts] }); return []; },
    // A send approval is linked to its message through params; a decision needs that link.
    getApproval: async (companyId, id) => {
      calls.push({ name: 'getApproval', companyId, rest: [id] });
      return { id: APPROVAL_ID, status: 'pending', params: { messageId: 'msg-1' } };
    },
    decideApproval: record('decideApproval'),
    revokeApproval: async (companyId, ...rest) => { calls.push({ name: 'revokeApproval', companyId, rest }); return { kind: 'ok', approval: { id: APPROVAL_ID } }; },
    resubmitApproval: async (companyId, ...rest) => { calls.push({ name: 'resubmitApproval', companyId, rest }); return { kind: 'ok', approval: { id: 'new' } }; },
    markExecuted: record('markExecuted'),
    listRules: async (companyId) => { calls.push({ name: 'listRules', companyId, rest: [] }); return []; },
  };
}

describe('approval routes company scope', () => {
  let server;
  let base;
  let calls;
  // Set per test: the company the verified session put on res.locals (null = none).
  let verifiedCompany;

  before(async () => {
    calls = [];
    const app = express();
    app.use(express.json());
    // Stands in for requireCompanyScope: sets res.locals.companyId from the verified session only.
    app.use('/api/approvals', (req, res, next) => {
      res.locals = res.locals ?? {};
      if (verifiedCompany) res.locals.companyId = verifiedCompany;
      // A req.user company that differs from the verified one must still be ignored.
      req.user = { id: 'u1', role: 'admin', companyId: ATTACKER };
      req.userId = 'u1';
      next();
    });
    app.use('/api/approvals', createApprovalRouter(makeService(calls), decisionDeps));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api/approvals`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('list uses the verified company and ignores a query-supplied company', async () => {
    verifiedCompany = TENANT;
    calls.length = 0;
    const res = await fetch(`${base}/?companyId=${ATTACKER}&company_id=${ATTACKER}`, { headers: { 'x-company-id': ATTACKER } });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].companyId, TENANT);
  });

  test('decision ignores body companyId and uses the verified company', async () => {
    verifiedCompany = TENANT;
    calls.length = 0;
    resetDecisionWrites();
    const res = await fetch(`${base}/${APPROVAL_ID}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companyId: ATTACKER, company_id: ATTACKER, reason: 'ok' }),
    });
    assert.equal(res.status, 200);
    // The decision runs through the injected runner, scoped to the verified company only.
    assert.deepEqual(decisionWrites.scopes, [TENANT]);
    assert.equal(decisionWrites.approval.length, 1);
    assert.equal(decisionWrites.approval[0].companyId, TENANT);
    assert.equal(decisionWrites.message.length, 1);
    assert.equal(decisionWrites.message[0].companyId, TENANT);
    assert.equal(JSON.stringify(decisionWrites).includes(ATTACKER), false);
  });

  test('decision is refused with 503 when no decision runner is injected', async () => {
    verifiedCompany = TENANT;
    const bare = express();
    bare.use(express.json());
    bare.use('/api/approvals', (req, res, next) => {
      res.locals = { companyId: TENANT };
      req.userId = 'u1';
      next();
    });
    bare.use('/api/approvals', createApprovalRouter(makeService([])));
    const srv = await new Promise((resolve) => { const s = bare.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/approvals/${APPROVAL_ID}/approve`, { method: 'POST' });
      assert.equal(res.status, 503);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  test('revoke, resubmit and executed all scope to the verified company', async () => {
    verifiedCompany = TENANT;
    calls.length = 0;
    await fetch(`${base}/${APPROVAL_ID}/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companyId: ATTACKER }),
    });
    await fetch(`${base}/${APPROVAL_ID}/resubmit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: { amount: 1 } }),
    });
    await fetch(`${base}/${APPROVAL_ID}/executed`, { method: 'POST' });
    const scoped = calls.filter((c) => ['revokeApproval', 'resubmitApproval', 'markExecuted'].includes(c.name));
    assert.equal(scoped.length, 3);
    for (const c of scoped) assert.equal(c.companyId, TENANT, c.name);
  });

  test('resubmit still refuses a companyId field in the body', async () => {
    verifiedCompany = TENANT;
    calls.length = 0;
    const res = await fetch(`${base}/${APPROVAL_ID}/resubmit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: {}, companyId: ATTACKER }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  test('fails closed with 403 when no verified company is on res.locals', async () => {
    verifiedCompany = null;
    calls.length = 0;
    const res = await fetch(`${base}/`, { headers: { 'x-company-id': ATTACKER } });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });
});
