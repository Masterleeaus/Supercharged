import test from 'node:test';
import assert from 'node:assert/strict';
import { DeskTrustReadiness, DeskTrustError } from '../../server/engines/trust/desk-adapter.ts';

const CO = 'company-a';
const JOB = 'job-1';

function fakePersistence({ rules = [], items = [] } = {}) {
  const calls = [];
  return {
    calls,
    async loadRules(companyId) {
      calls.push(['rules', companyId]);
      return rules;
    },
    async loadItems(companyId, jobId) {
      calls.push(['items', companyId, jobId]);
      return items;
    },
  };
}

const rule = (companyId = CO, required = { before: 1 }) => ({
  id: 'r1',
  companyId,
  templateId: null,
  jobType: null,
  siteType: null,
  required,
});

test('refuses every call when persistence is not bound', async () => {
  const adapter = new DeskTrustReadiness();
  await assert.rejects(() => adapter.evaluateJob({ companyId: CO, jobId: JOB }), (e) => e.code === 'persistence_not_injected');
});

test('company_id is required and checked before persistence is touched', async () => {
  const persistence = fakePersistence();
  const adapter = new DeskTrustReadiness({ persistence });
  for (const bad of [undefined, null, '', '  ']) {
    await assert.rejects(() => adapter.evaluateJob({ companyId: bad, jobId: JOB }), (e) => e.code === 'company_id_required');
  }
  assert.deepEqual(persistence.calls, []);
});

test('loads rules and items for the company and job, then evaluates them', async () => {
  const persistence = fakePersistence({ rules: [rule()], items: [{ companyId: CO, jobId: JOB, evidenceType: 'before' }] });
  const result = await new DeskTrustReadiness({ persistence }).evaluateJob({ companyId: CO, jobId: JOB });
  assert.deepEqual(persistence.calls, [['rules', CO], ['items', CO, JOB]]);
  assert.equal(result.status, 'ready');
  assert.equal(result.ready, true);
});

test('with no rule loaded the result is not ready', async () => {
  const result = await new DeskTrustReadiness({ persistence: fakePersistence() }).evaluateJob({ companyId: CO, jobId: JOB });
  assert.equal(result.status, 'no_rule');
  assert.equal(result.ready, false);
});

test('a rule that belongs to another company is ignored', async () => {
  const persistence = fakePersistence({ rules: [rule('company-b', { before: 0 })] });
  const result = await new DeskTrustReadiness({ persistence }).evaluateJob({ companyId: CO, jobId: JOB });
  assert.equal(result.status, 'no_rule');
  assert.equal(result.ready, false);
});

test('missing evidence is reported as not_ready with the shortfall', async () => {
  const persistence = fakePersistence({ rules: [rule(CO, { before: 2 })], items: [{ companyId: CO, jobId: JOB, evidenceType: 'before' }] });
  const result = await new DeskTrustReadiness({ persistence }).evaluateJob({ companyId: CO, jobId: JOB });
  assert.equal(result.status, 'not_ready');
  assert.equal(result.missing.before, 1);
});

test('DeskTrustError is exported with a code', () => {
  const err = new DeskTrustError('x');
  assert.equal(err.code, 'x');
  assert.equal(err.name, 'DeskTrustError');
});
