/**
 * Tests for server/workforce/runtime/compose.ts and health.ts. In-memory store, fake approval service, fake
 * read store, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/compose.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWorkforceRuntime } from '../../server/workforce/runtime/compose.ts';
import { runtimeHealth, workforceHealthHandler } from '../../server/workforce/runtime/health.ts';
import { createMemoryRunStore } from '../../server/workforce/runtime/store.ts';
import { evaluatePolicy } from '../../server/modules/approvals/policy-evaluator.ts';
import { GROUP03_TOOL_IDS } from '../../server/workforce/tools/handlers/group-03.ts';

const CO = 'company-1';

function fakeApprovalService() {
  return {
    async gateAction() {
      return { status: 'pending', approval: { id: 'a1' } };
    },
    async getApproval() {
      return null;
    },
    async markExecuted() {
      return null;
    },
  };
}

function fakeReadStore() {
  return {
    async listBookings() {
      return [];
    },
    async getBooking() {
      return null;
    },
    async listInvoices() {
      return [];
    },
    async getInvoice() {
      return null;
    },
    async listPayments() {
      return [];
    },
  };
}

function fakeDeps(overrides = {}) {
  return {
    store: createMemoryRunStore(),
    catalogue: new Map([['writer', { id: 'writer' }]]),
    approvalService: fakeApprovalService(),
    readStore: fakeReadStore(),
    redact: (value) => value,
    companyScope: CO,
    ...overrides,
  };
}

// ---------- missing dependencies fail closed ----------

test('compose throws when the run store is missing', () => {
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ store: undefined })), /run store/);
});

test('compose throws when the role catalogue is missing', () => {
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ catalogue: undefined })), /role catalogue/);
});

test('compose throws when the approval service is missing', () => {
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ approvalService: null })), /approval service/);
});

test('compose throws when the read store or redactor is missing', () => {
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ readStore: undefined })), /read store/);
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ redact: undefined })), /redactor/);
});

test('compose throws when the store lacks a required method', () => {
  const store = createMemoryRunStore();
  delete store.listAudit;
  assert.throws(() => composeWorkforceRuntime(fakeDeps({ store })), /missing listAudit/);
});

// ---------- composition ----------

test('compose registers the five bound read tools and the group 03 handlers, and nothing else', () => {
  // The group 03 handlers include writes. Each one is gated by its access and category (see tools-real-03.test.mjs).
  const runtime = composeWorkforceRuntime(fakeDeps());
  const ids = runtime.registry.list().map((t) => t.id).sort();
  assert.deepEqual(
    ids,
    ['booking_requests.get', 'booking_requests.list', 'invoices.get', 'invoices.list', 'payments.list', ...GROUP03_TOOL_IDS].sort(),
  );
  assert.equal(runtime.model, null);
});

test('engine startRun refuses with model_not_configured and never moves a run', async () => {
  const runtime = composeWorkforceRuntime(fakeDeps());
  const result = await runtime.engine.startRun(CO, 'run-1');
  assert.deepEqual(result, { ok: false, reason: 'model_not_configured', run: null });
});

test('compose keeps the injected policy evaluator and defaults to evaluatePolicy', () => {
  assert.equal(composeWorkforceRuntime(fakeDeps()).policyEvaluator, evaluatePolicy);
  const custom = () => ({ decision: 'deny', reason: 'test' });
  assert.equal(composeWorkforceRuntime(fakeDeps({ policyEvaluator: custom })).policyEvaluator, custom);
});

// ---------- health ----------

test('health reports model NOT CONFIGURED and overall not ready for a complete runtime', () => {
  const health = runtimeHealth(composeWorkforceRuntime(fakeDeps()));
  assert.equal(health.dependencies.model, 'NOT CONFIGURED');
  assert.equal(health.status, 'not_ready');
});

test('health reports every other dependency ready for a complete fake set', () => {
  const health = runtimeHealth(composeWorkforceRuntime(fakeDeps()));
  assert.deepEqual(health.dependencies, {
    store: 'ready',
    catalogue: 'ready',
    approvals: 'ready',
    policy: 'ready',
    model: 'NOT CONFIGURED',
    identity: 'ready',
  });
});

test('health reports identity not ready when no company scope is set', () => {
  const runtime = composeWorkforceRuntime(fakeDeps({ companyScope: undefined }));
  const health = runtimeHealth(runtime);
  assert.equal(health.dependencies.identity, 'not_ready');
  assert.equal(health.status, 'not_ready');
});

test('health reports every dependency not ready when no runtime is composed', () => {
  const health = runtimeHealth(null);
  assert.deepEqual(health.dependencies, {
    store: 'not_ready',
    catalogue: 'not_ready',
    approvals: 'not_ready',
    policy: 'not_ready',
    model: 'NOT CONFIGURED',
    identity: 'not_ready',
  });
  assert.equal(health.status, 'not_ready');
});

test('health route handler answers 503 with the report when not ready', () => {
  let code = null;
  let body = null;
  const res = {
    status(c) {
      code = c;
      return this;
    },
    json(b) {
      body = b;
      return this;
    },
  };
  workforceHealthHandler({}, res);
  assert.equal(code, 503);
  assert.equal(body.dependencies.model, 'NOT CONFIGURED');
  assert.equal(body.status, 'not_ready');
});
