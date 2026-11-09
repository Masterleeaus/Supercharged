/**
 * Checklist: "Record actor, agent, company, policy version, tier, parameters or safe hashes, outcome, timestamps".
 *
 * Runs real tool calls through the real tool registry with the in-memory run store, then checks every audit event
 * each call wrote (decision and execution) for each required field. Also checks that no raw param value or secret
 * appears in any stored event. The in-memory store does not redact, so the registry's own output is what is tested.
 *
 * Each field has its own test, so a missing field shows up as its own failure with the events that lack it.
 * No network, no database, no real timers.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/audit-fields.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, hashToolParams } from '../../server/workforce/runtime/tool-registry.ts';
import { createMemoryRunStore } from '../../server/workforce/runtime/store.ts';
import { redactForAudit } from '../../server/workforce/runtime/redact.ts';
import { RISK_TIERS } from '../../server/modules/approvals/authority-ladder.ts';

const CO = 'company-1';
const FIXED_AT = '2026-11-03T00:00:00.000Z';

const SECRET_KEY = 'sk_test_FAKE_FIXTURE_ONLY';
const SECRET_BEARER = 'abcdefSECRETTOKEN123';
const SECRET_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SIGNATUREPART';
const PII_EMAIL = 'jane@example.com';
const LEAK_CANARIES = [SECRET_KEY, SECRET_BEARER, SECRET_JWT, PII_EMAIL];

const AGENT = { kind: 'agent', agentId: 'agent-1', roleId: 'role-1', autonomy: 'suggest' };
const AUTO_AGENT = { kind: 'agent', agentId: 'agent-2', roleId: 'role-2', autonomy: 'auto' };
const HUMAN = { kind: 'human', userId: 'owner-1' };

const TOOLS = [
  { id: 'invoices.list', risk: 'low', access: 'read', schema: { customer: { type: 'string' }, note: { type: 'string' } } },
  { id: 'invoices.sync', risk: 'low', access: 'read', schema: { note: { type: 'string' } }, fails: true },
  { id: 'notes.write', risk: 'low', access: 'write', schema: { note: { type: 'string' } } },
  { id: 'payments.refund', risk: 'low', access: 'write', category: 'money', schema: { note: { type: 'string' } } },
];

const SCENARIOS = [
  { name: 'agent read executed', companyId: CO, toolId: 'invoices.list', params: { customer: PII_EMAIL, note: SECRET_KEY }, actor: AGENT, agent: true, expect: 'executed' },
  { name: 'agent read handler failed', companyId: CO, toolId: 'invoices.sync', params: { note: `Bearer ${SECRET_BEARER}` }, actor: AGENT, agent: true, expect: 'failed' },
  { name: 'auto agent write awaiting approval', companyId: CO, toolId: 'payments.refund', params: { note: SECRET_JWT }, actor: AUTO_AGENT, agent: true, expect: 'awaiting_approval' },
  { name: 'agent write denied by ladder', companyId: CO, toolId: 'notes.write', params: { note: SECRET_KEY }, actor: AGENT, agent: true, expect: 'refused' },
  { name: 'unknown tool refused', companyId: CO, toolId: 'ghost.tool', params: { note: SECRET_KEY }, actor: AGENT, agent: true, expect: 'refused' },
  { name: 'tenant override refused', companyId: CO, toolId: 'invoices.list', params: { company_id: 'company-2', note: SECRET_KEY }, actor: AGENT, agent: true, expect: 'refused' },
  { name: 'invalid input refused', companyId: CO, toolId: 'invoices.list', params: { note: 12 }, actor: AGENT, agent: true, expect: 'refused' },
  { name: 'human read executed', companyId: CO, toolId: 'invoices.list', params: { customer: PII_EMAIL, note: SECRET_KEY }, actor: HUMAN, agent: false, expect: 'executed' },
  { name: 'no company refused', companyId: undefined, toolId: 'invoices.list', params: { note: SECRET_KEY }, actor: AGENT, agent: true, expect: 'refused' },
];

const FIXED_CLOCK = () => new Date(FIXED_AT);

function fakeGate() {
  let seq = 0;
  const approvals = new Map();
  return {
    gateCalls: 0,
    async gateAction(req) {
      this.gateCalls += 1;
      const id = `ap-${++seq}`;
      approvals.set(id, { id, companyId: req.companyId, action: req.action, status: 'pending', paramsSha256: req.context.paramsSha256 });
      return { status: 'pending', approval: { id } };
    },
    async readApproval(companyId, id) {
      const a = approvals.get(id);
      return a ? { ...a } : null;
    },
    async claimApproval() {
      return false;
    },
  };
}

async function runScenario(s) {
  const store = createMemoryRunStore();
  const registry = createToolRegistry({
    gate: fakeGate(),
    redact: redactForAudit,
    audit: { record: (event) => store.appendAudit(event) },
    now: FIXED_CLOCK,
  });
  for (const def of TOOLS) {
    registry.register({
      id: def.id,
      risk: def.risk,
      access: def.access,
      category: def.category,
      schema: def.schema,
      handler: async () => {
        if (def.fails) throw new Error(`upstream rejected Bearer ${SECRET_BEARER}`);
        return { ok: true };
      },
    });
  }
  const result = await registry.invoke({ companyId: s.companyId, toolId: s.toolId, params: s.params, identityVerified: true, actor: s.actor, runId: 'run-1' });
  const events = [...(await store.listAudit(CO)), ...store.unscopedAudit()];
  return { s, result, events };
}

let cache = null;
async function allRuns() {
  if (!cache) cache = await Promise.all(SCENARIOS.map(runScenario));
  return cache;
}

function eventLabel(run, e) {
  return `${run.s.name} [${e.kind}/${String(e.data.outcome)}]`;
}

/** Returns the labels of every event that fails the predicate. Empty means every event passes. */
function missingFor(runs, predicate) {
  const misses = [];
  for (const run of runs) {
    for (const e of run.events) {
      if (!predicate(e, run.s)) misses.push(eventLabel(run, e));
    }
  }
  return misses;
}

test('every scenario reaches its intended outcome and writes at least one audit event', async () => {
  const runs = await allRuns();
  for (const run of runs) {
    assert.equal(run.result.outcome, run.s.expect, `${run.s.name}: outcome`);
    assert.ok(run.events.length >= 1, `${run.s.name}: no audit event was written`);
  }
});

// A call with no company cannot be attributed to a tenant, so its refusal is recorded with a null company.
// Every other event must name the company that made the call.
test('company is recorded on every tool audit event, or null only for a call with no company', async () => {
  const runs = await allRuns();
  assert.deepEqual(missingFor(runs, (e) => e.companyId === CO || (e.companyId === null && e.data?.reason === 'company_id_required')), []);
});

test('actor (actorKind and actorId) is recorded on every tool audit event', async () => {
  const runs = await allRuns();
  assert.deepEqual(
    missingFor(runs, (e) => (e.data.actorKind === 'agent' || e.data.actorKind === 'human') && typeof e.data.actorId === 'string' && e.data.actorId !== ''),
    [],
  );
});

test('agent identity is recorded on every agent tool audit event', async () => {
  const runs = await allRuns();
  assert.deepEqual(
    missingFor(runs.filter((r) => r.s.agent), (e, s) => e.data.actorKind === 'agent' && e.data.actorId === s.actor.agentId),
    [],
  );
});

test('policy version is recorded on every tool audit event', async () => {
  const runs = await allRuns();
  assert.deepEqual(missingFor(runs, (e) => typeof e.data.policyVersion === 'string' && e.data.policyVersion !== ''), []);
});

test('tier is recorded on every tool audit event', async () => {
  const runs = await allRuns();
  assert.deepEqual(missingFor(runs, (e) => RISK_TIERS.includes(e.data.tier)), []);
});

test('a SHA-256 hash of the exact params is recorded on every tool audit event', async () => {
  const runs = await allRuns();
  assert.deepEqual(
    missingFor(runs, (e, s) => typeof e.data.paramsSha256 === 'string' && e.data.paramsSha256 === hashToolParams(s.params)),
    [],
  );
});

test('outcome is recorded on every tool audit event', async () => {
  const runs = await allRuns();
  assert.deepEqual(missingFor(runs, (e) => typeof e.data.outcome === 'string' && e.data.outcome !== ''), []);
});

test('timestamp is recorded on every tool audit event and comes from the injected clock', async () => {
  const runs = await allRuns();
  assert.deepEqual(missingFor(runs, (e) => e.at === FIXED_AT), []);
});

test('no raw param value or secret appears in any stored audit event', async () => {
  const runs = await allRuns();
  const leaks = [];
  for (const run of runs) {
    for (const e of run.events) {
      const json = JSON.stringify(e);
      for (const canary of LEAK_CANARIES) {
        if (json.includes(canary)) leaks.push(`${eventLabel(run, e)} contains ${canary.slice(0, 6)}...`);
      }
    }
  }
  assert.deepEqual(leaks, []);
});
