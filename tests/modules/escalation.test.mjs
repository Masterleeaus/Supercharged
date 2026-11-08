import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEscalation } from '../../server/modules/comms/escalation.ts';

// Pure logic only. Fixed clock; times in ms.

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const COMPANY = 'co-1';

const thread = (overrides = {}) => ({
  id: 'thr-1',
  companyId: COMPANY,
  assignedTo: 'agent-7',
  dueAt: T0,
  ...overrides,
});

const RULES = [
  { afterMinutesOverdue: 30, escalateTo: 'team-lead' },
  { afterMinutesOverdue: 120, escalateTo: 'manager' },
  { afterMinutesOverdue: 480, escalateTo: 'owner' },
];

// Evaluate the standard thread at a given number of minutes overdue.
const at = (minutes, { status = 'breached', rules = RULES, ...t } = {}) =>
  evaluateEscalation({
    thread: thread(t),
    status,
    now: T0 + minutes * MIN,
    rules,
  });

// ---------- breach status ----------

test('an open thread never escalates, even far past every threshold', () => {
  assert.deepEqual(at(1000, { status: 'open' }), { escalate: false, reason: 'not_breached' });
});

test('a replied thread never escalates, even far past every threshold', () => {
  assert.deepEqual(at(1000, { status: 'replied' }), { escalate: false, reason: 'not_breached' });
});

test('a breached thread escalates once a threshold is reached', () => {
  const result = at(30);
  assert.equal(result.escalate, true);
  assert.equal(result.escalateTo, 'team-lead');
});

test('an unknown status is refused rather than escalated', () => {
  assert.deepEqual(at(1000, { status: 'paused' }), { escalate: false, reason: 'invalid_status' });
});

// ---------- threshold and highest rule ----------

test('no escalation below the first threshold', () => {
  assert.deepEqual(at(29), { escalate: false, reason: 'below_threshold' });
});

test('the first threshold is inclusive', () => {
  assert.equal(at(30).rule.afterMinutesOverdue, 30);
});

test('the highest reached rule wins, not the first reached', () => {
  const result = at(150);
  assert.equal(result.escalate, true);
  assert.equal(result.rule.afterMinutesOverdue, 120);
  assert.equal(result.escalateTo, 'manager');
});

test('the top rule wins once it is reached', () => {
  const result = at(480);
  assert.equal(result.rule.afterMinutesOverdue, 480);
  assert.equal(result.escalateTo, 'owner');
});

test('between thresholds the lower reached rule stays in force', () => {
  assert.equal(at(119).escalateTo, 'team-lead');
});

test('when two rules share a threshold, the later one in the list wins', () => {
  const rules = [
    { afterMinutesOverdue: 30, escalateTo: 'first' },
    { afterMinutesOverdue: 30, escalateTo: 'second' },
  ];
  assert.equal(at(30, { rules }).escalateTo, 'second');
});

test('an empty rule list never escalates', () => {
  assert.deepEqual(at(1000, { rules: [] }), { escalate: false, reason: 'below_threshold' });
});

// ---------- minPriority gating ----------

test('a rule with minPriority is skipped for a lower-priority thread', () => {
  const rules = [
    { afterMinutesOverdue: 30, escalateTo: 'team-lead' },
    { afterMinutesOverdue: 60, escalateTo: 'manager', minPriority: 'high' },
  ];
  const result = at(90, { rules, priority: 'normal' });
  assert.equal(result.escalateTo, 'team-lead');
});

test('a skipped top rule falls back to the next lower reached rule', () => {
  const rules = [
    { afterMinutesOverdue: 30, escalateTo: 'team-lead' },
    { afterMinutesOverdue: 60, escalateTo: 'manager', minPriority: 'urgent' },
  ];
  assert.equal(at(90, { rules, priority: 'high' }).escalateTo, 'team-lead');
});

test('a thread at exactly minPriority passes the gate', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: 'manager', minPriority: 'high' }];
  assert.equal(at(30, { rules, priority: 'high' }).escalateTo, 'manager');
});

test('a thread above minPriority passes the gate', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: 'manager', minPriority: 'high' }];
  assert.equal(at(30, { rules, priority: 'urgent' }).escalateTo, 'manager');
});

test('a gated rule with no reached fallback gives below_threshold', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: 'manager', minPriority: 'urgent' }];
  assert.deepEqual(at(60, { rules, priority: 'low' }), { escalate: false, reason: 'below_threshold' });
});

test('a thread with no priority is treated as normal for minPriority', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: 'manager', minPriority: 'high' }];
  assert.deepEqual(at(30, { rules }), { escalate: false, reason: 'below_threshold' });
  const normalRules = [{ afterMinutesOverdue: 30, escalateTo: 'manager', minPriority: 'normal' }];
  assert.equal(at(30, { rules: normalRules }).escalateTo, 'manager');
});

test('an unknown thread priority is refused', () => {
  assert.deepEqual(at(30, { priority: 'critical' }), { escalate: false, reason: 'invalid_thread' });
});

// ---------- assignment ----------

test('an unassigned thread escalates to rule.escalateTo unchanged', () => {
  const result = at(30, { assignedTo: null });
  assert.equal(result.escalate, true);
  assert.equal(result.escalateTo, 'team-lead');
});

test('an assigned thread escalates to the same rule target', () => {
  assert.equal(at(30, { assignedTo: 'agent-7' }).escalateTo, 'team-lead');
});

// ---------- rule list validation ----------

test('unsorted rules are refused', () => {
  const rules = [
    { afterMinutesOverdue: 120, escalateTo: 'manager' },
    { afterMinutesOverdue: 30, escalateTo: 'team-lead' },
  ];
  assert.deepEqual(at(200, { rules }), { escalate: false, reason: 'invalid_rules' });
});

test('unsorted rules are refused even when the thread is not breached', () => {
  const rules = [
    { afterMinutesOverdue: 120, escalateTo: 'manager' },
    { afterMinutesOverdue: 30, escalateTo: 'team-lead' },
  ];
  assert.deepEqual(at(200, { rules, status: 'open' }), { escalate: false, reason: 'invalid_rules' });
});

test('a rule with an empty escalateTo is refused', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: '' }];
  assert.deepEqual(at(60, { rules }), { escalate: false, reason: 'invalid_rules' });
});

test('a rule with a whitespace-only escalateTo is refused', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: '   ' }];
  assert.deepEqual(at(60, { rules }), { escalate: false, reason: 'invalid_rules' });
});

test('a rule with a negative or non-numeric threshold is refused', () => {
  assert.deepEqual(
    at(60, { rules: [{ afterMinutesOverdue: -5, escalateTo: 'x' }] }),
    { escalate: false, reason: 'invalid_rules' },
  );
  assert.deepEqual(
    at(60, { rules: [{ afterMinutesOverdue: '30', escalateTo: 'x' }] }),
    { escalate: false, reason: 'invalid_rules' },
  );
});

test('a rule with an unknown minPriority is refused', () => {
  const rules = [{ afterMinutesOverdue: 30, escalateTo: 'x', minPriority: 'critical' }];
  assert.deepEqual(at(60, { rules }), { escalate: false, reason: 'invalid_rules' });
});

test('a non-list rules value is refused', () => {
  assert.deepEqual(at(60, { rules: null }), { escalate: false, reason: 'invalid_rules' });
  assert.deepEqual(at(60, { rules: { escalateTo: 'x' } }), { escalate: false, reason: 'invalid_rules' });
});

// ---------- company scope ----------

test('a wrapped rules set for the thread company is accepted', () => {
  const result = at(30, { rules: { companyId: COMPANY, rules: RULES } });
  assert.equal(result.escalateTo, 'team-lead');
});

test('rules belonging to another company are refused', () => {
  const rules = { companyId: 'co-2', rules: RULES };
  assert.deepEqual(at(500, { rules }), { escalate: false, reason: 'company_mismatch' });
});

test('rules with no companyId in wrapped form are refused as a mismatch', () => {
  const rules = { rules: RULES };
  assert.deepEqual(at(500, { rules }), { escalate: false, reason: 'company_mismatch' });
});

test('a cross-company rule never produces an escalation target', () => {
  const rules = { companyId: 'co-2', rules: [{ afterMinutesOverdue: 0, escalateTo: 'foreign' }] };
  const result = at(500, { rules });
  assert.equal(result.escalate, false);
  assert.equal('escalateTo' in result, false);
});

// ---------- minutes overdue from now ----------

test('minutesOverdue is computed from now minus dueAt', () => {
  const result = at(45);
  assert.equal(result.minutesOverdue, 45);
});

test('minutesOverdue rounds down to whole minutes', () => {
  const result = evaluateEscalation({
    thread: thread(),
    status: 'breached',
    now: T0 + 30 * MIN + 59_999,
    rules: RULES,
  });
  assert.equal(result.minutesOverdue, 30);
  assert.equal(result.escalate, true);
});

test('minutesOverdue is zero before the due time, never negative', () => {
  const result = evaluateEscalation({
    thread: thread({ dueAt: T0 + 10 * MIN }),
    status: 'breached',
    now: T0,
    rules: RULES,
  });
  assert.deepEqual(result, { escalate: false, reason: 'below_threshold' });
});

test('a later now moves a thread up to a higher rule', () => {
  assert.equal(at(29).escalate, false);
  assert.equal(at(30).escalateTo, 'team-lead');
  assert.equal(at(120).escalateTo, 'manager');
});

test('a thread with a non-numeric dueAt is refused', () => {
  const result = evaluateEscalation({
    thread: { id: 't', companyId: COMPANY, dueAt: Number.NaN },
    status: 'breached',
    now: T0,
    rules: RULES,
  });
  assert.deepEqual(result, { escalate: false, reason: 'invalid_thread' });
});

test('a non-finite now is refused', () => {
  const result = evaluateEscalation({
    thread: thread(),
    status: 'breached',
    now: Number.NaN,
    rules: RULES,
  });
  assert.deepEqual(result, { escalate: false, reason: 'invalid_input' });
});

// ---------- result shape ----------

test('an escalation reports the rule, target, minutes and reason', () => {
  const result = at(150);
  assert.equal(result.escalate, true);
  assert.deepEqual(result.rule, { afterMinutesOverdue: 120, escalateTo: 'manager' });
  assert.equal(result.escalateTo, 'manager');
  assert.equal(result.minutesOverdue, 150);
  assert.equal(result.reason, 'rule_reached');
});

test('the input rules are not mutated', () => {
  const rules = RULES.map((r) => ({ ...r }));
  at(500, { rules });
  assert.deepEqual(rules, RULES);
});
