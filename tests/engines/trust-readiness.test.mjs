import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEvidenceReadiness,
  selectEvidenceRule,
  TrustReadinessError,
} from '../../server/engines/trust/index.ts';

const CO = 'company-a';
const JOB = 'job-1';

const rule = (id, extra = {}, companyId = CO) => ({
  id,
  companyId,
  templateId: null,
  jobType: null,
  siteType: null,
  required: {},
  ...extra,
});

const item = (evidenceType, extra = {}) => ({ companyId: CO, jobId: JOB, evidenceType, ...extra });

test('no rule at all is not ready, never ready', () => {
  const r = evaluateEvidenceReadiness({ companyId: CO, jobId: JOB, rules: [], items: [] });
  assert.equal(r.status, 'no_rule');
  assert.equal(r.ready, false);
  assert.equal(r.rule, null);
});

test('rules for another company do not apply, so the result is no_rule', () => {
  const r = evaluateEvidenceReadiness({
    companyId: CO,
    jobId: JOB,
    rules: [rule('x', { required: { before: 0 } }, 'company-b')],
    items: [],
  });
  assert.equal(r.status, 'no_rule');
  assert.equal(r.ready, false);
});

test('a catch-all rule with zero requirements is ready', () => {
  const r = evaluateEvidenceReadiness({ companyId: CO, jobId: JOB, rules: [rule('any')], items: [] });
  assert.equal(r.status, 'ready');
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, { before: 0, after: 0, incident: 0, signoff: 0, general: 0 });
});

test('defaults fill unlisted types with zero, and missing counts are reported', () => {
  const r = evaluateEvidenceReadiness({
    companyId: CO,
    jobId: JOB,
    rules: [rule('any', { required: { before: 2 } })],
    items: [item('before')],
  });
  assert.equal(r.status, 'not_ready');
  assert.equal(r.required.before, 2);
  assert.equal(r.required.after, 0);
  assert.equal(r.captured.before, 1);
  assert.equal(r.missing.before, 1);
  assert.equal(r.ready, false);
});

test('meeting every requirement, with surplus items, is ready', () => {
  const r = evaluateEvidenceReadiness({
    companyId: CO,
    jobId: JOB,
    rules: [rule('any', { required: { before: 1, signoff: 1 } })],
    items: [item('before'), item('before'), item('signoff')],
  });
  assert.equal(r.status, 'ready');
  assert.equal(r.captured.before, 2);
  assert.equal(r.missing.before, 0);
});

test('items for another job or company are not counted', () => {
  const r = evaluateEvidenceReadiness({
    companyId: CO,
    jobId: JOB,
    rules: [rule('any', { required: { before: 1 } })],
    items: [
      { companyId: CO, jobId: 'job-2', evidenceType: 'before' },
      { companyId: 'company-b', jobId: JOB, evidenceType: 'before' },
    ],
  });
  assert.equal(r.status, 'not_ready');
  assert.equal(r.captured.before, 0);
});

test('template match outranks job and site match', () => {
  const rules = [
    rule('job-site', { jobType: 'clean', siteType: 'office' }),
    rule('template', { templateId: 7 }),
  ];
  assert.equal(selectEvidenceRule({ companyId: CO, jobId: JOB, templateId: 7, jobType: 'clean', siteType: 'office', rules, items: [] }).id, 'template');
});

test('job and site match outranks job only, which outranks site only, which outranks catch-all', () => {
  const q = (rules) => ({ companyId: CO, jobId: JOB, jobType: 'clean', siteType: 'office', rules, items: [] });
  assert.equal(selectEvidenceRule(q([rule('catch'), rule('site', { siteType: 'office' }), rule('job', { jobType: 'clean' }), rule('both', { jobType: 'clean', siteType: 'office' })])).id, 'both');
  assert.equal(selectEvidenceRule(q([rule('catch'), rule('site', { siteType: 'office' }), rule('job', { jobType: 'clean' })])).id, 'job');
  assert.equal(selectEvidenceRule(q([rule('catch'), rule('site', { siteType: 'office' })])).id, 'site');
  assert.equal(selectEvidenceRule(q([rule('catch')])).id, 'catch');
});

test('a rule that is more specific than the job does not apply to it', () => {
  // A rule pinned to another job type must not match a job of a different type.
  const r = evaluateEvidenceReadiness({
    companyId: CO,
    jobId: JOB,
    jobType: 'clean',
    rules: [rule('repair', { jobType: 'repair', required: { before: 5 } })],
    items: [],
  });
  assert.equal(r.status, 'no_rule');
  assert.equal(r.ready, false);
});

test('a template-pinned rule does not apply when the job has no template', () => {
  const r = evaluateEvidenceReadiness({
    companyId: CO,
    jobId: JOB,
    rules: [rule('tpl', { templateId: 9, required: { before: 1 } })],
    items: [],
  });
  assert.equal(r.status, 'no_rule');
});

test('on a tie the first rule in input order wins', () => {
  const rules = [rule('first', { required: { before: 1 } }), rule('second', { required: { before: 2 } })];
  const r = evaluateEvidenceReadiness({ companyId: CO, jobId: JOB, rules, items: [] });
  assert.equal(r.rule.id, 'first');
});

test('the evaluator rejects a missing or blank company_id', () => {
  for (const companyId of [undefined, null, '', '   ', 42]) {
    assert.throws(
      () => evaluateEvidenceReadiness({ companyId, jobId: JOB, rules: [rule('any')], items: [] }),
      (err) => err instanceof TrustReadinessError && err.code === 'company_id_required',
    );
  }
});

test('the evaluator rejects a missing job_id', () => {
  assert.throws(
    () => evaluateEvidenceReadiness({ companyId: CO, jobId: '', rules: [rule('any')], items: [] }),
    (err) => err.code === 'job_id_required',
  );
});

test('non-integer or negative required counts throw instead of being coerced', () => {
  for (const bad of [-1, 1.5, '2', null, Number.NaN]) {
    assert.throws(
      () => evaluateEvidenceReadiness({ companyId: CO, jobId: JOB, rules: [rule('any', { required: { before: bad } })], items: [] }),
      (err) => err.code === 'invalid_required_count',
    );
  }
});

test('the input rules and items are not mutated', () => {
  const rules = [rule('any', { required: { before: 1 } })];
  const items = [item('before')];
  const snapshot = JSON.stringify({ rules, items });
  evaluateEvidenceReadiness({ companyId: CO, jobId: JOB, rules, items });
  assert.equal(JSON.stringify({ rules, items }), snapshot);
});
