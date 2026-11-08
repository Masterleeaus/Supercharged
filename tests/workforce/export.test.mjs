/**
 * Tests for server/workforce/runtime/export.ts and the workforce.export audit kind.
 * In-memory store and audit sink only. No database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/export.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRunStore } from '../../server/workforce/runtime/store.ts';
import { AUDIT_KINDS } from '../../server/workforce/runtime/store.ts';
import { exportCompanyData, ExportRefusedError, EXPORT_AUDIT_KIND } from '../../server/workforce/runtime/export.ts';

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const A = 'company-a';
const B = 'company-b';

function makeRun(companyId, id, overrides = {}) {
  return {
    id,
    companyId,
    status: 'completed',
    version: 1,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    team: { roles: [] },
    path: ['coordinator', 'worker'],
    delegations: [],
    limits: {},
    budget: { maxTokens: 1000, maxToolCalls: 5, tokensUsed: 120, toolCalls: 2 },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    pendingApproval: null,
    reason: 'done, said "ok"',
    ...overrides,
  };
}

function recordingAudit() {
  const events = [];
  return {
    events,
    async record(event) {
      events.push(event);
    },
  };
}

async function seeded() {
  const store = createMemoryRunStore();
  await store.insertRun(A, makeRun(A, 'run-a1'));
  await store.insertRun(B, makeRun(B, 'run-b1'));
  await store.appendAudit({ id: 'ev-a1', companyId: A, runId: 'run-a1', kind: 'run.created', at: new Date(T0).toISOString(), data: {} });
  await store.appendAudit({ id: 'ev-a2', companyId: A, runId: 'run-a1', kind: 'tool.execution', at: new Date(T0).toISOString(), data: { toolId: 'x' } });
  await store.appendAudit({ id: 'ev-b1', companyId: B, runId: 'run-b1', kind: 'tool.execution', at: new Date(T0).toISOString(), data: { toolId: 'secret-b' } });
  return store;
}

const now = () => new Date(T0);

test("'workforce.export' is an audit kind", () => {
  assert.ok(AUDIT_KINDS.includes(EXPORT_AUDIT_KIND));
  assert.equal(EXPORT_AUDIT_KIND, 'workforce.export');
});

test('an unknown company is refused and nothing is recorded', async () => {
  const store = await seeded();
  const audit = recordingAudit();
  for (const bad of ['', 'bad id!', null, undefined, -4]) {
    await assert.rejects(
      exportCompanyData({ store, audit, now }, bad, 'json'),
      (err) => err instanceof ExportRefusedError && err.code === 'company_unknown',
    );
  }
  assert.equal(audit.events.length, 0);
});

test('an unsupported format is refused and nothing is recorded', async () => {
  const store = await seeded();
  const audit = recordingAudit();
  await assert.rejects(
    exportCompanyData({ store, audit, now }, A, 'xml'),
    (err) => err instanceof ExportRefusedError && err.code === 'format_unsupported',
  );
  assert.equal(audit.events.length, 0);
});

test('JSON export holds only the requested company and records one audit event', async () => {
  const store = await seeded();
  const audit = recordingAudit();
  const result = await exportCompanyData({ store, audit, now }, A, 'json');

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].contentType, 'application/json');
  const doc = JSON.parse(result.files[0].body);
  assert.deepEqual(doc.runs.map((r) => r.id), ['run-a1']);
  assert.deepEqual(doc.auditEvents.map((e) => e.id), ['ev-a1', 'ev-a2']);
  assert.deepEqual(doc.toolCalls.map((e) => e.id), ['ev-a2']);
  assert.equal(doc.budgetUsage.length, 1);
  assert.equal(result.files[0].body.includes('secret-b'), false);
  assert.equal(result.files[0].body.includes('run-b1'), false);

  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].kind, 'workforce.export');
  assert.equal(audit.events[0].companyId, A);
  assert.equal(audit.events[0].runId, null);
  assert.equal(audit.events[0].data.format, 'json');
  assert.equal(audit.events[0].data.runCount, 1);
});

test('CSV export writes one file per table, scoped to the company, with escaped cells', async () => {
  const store = await seeded();
  const audit = recordingAudit();
  const result = await exportCompanyData({ store, audit, now }, A, 'csv');

  const names = result.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['audit_events.csv', 'budget_usage.csv', 'runs.csv', 'tool_calls.csv']);
  const runs = result.files.find((f) => f.name === 'runs.csv').body;
  const lines = runs.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /run-a1/);
  assert.match(lines[1], /"done, said ""ok"""/);
  for (const f of result.files) assert.equal(f.body.includes('secret-b'), false);
  assert.equal(audit.events[0].data.fileCount, 4);
});

test('a failed audit write means no export is returned', async () => {
  const store = await seeded();
  const audit = {
    async record() {
      throw new Error('audit store down');
    },
  };
  await assert.rejects(exportCompanyData({ store, audit, now }, A, 'json'), /audit store down/);
});

test('the audit event carries a hash of the content, not the content', async () => {
  const store = await seeded();
  const audit = recordingAudit();
  const result = await exportCompanyData({ store, audit, now }, A, 'json');
  const hash = audit.events[0].data.contentSha256;
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(audit.events[0].data).includes('run-a1'), false);
  assert.equal(result.companyId, A);
});
