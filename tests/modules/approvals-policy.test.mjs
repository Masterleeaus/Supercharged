import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../../server/modules/approvals/policy-engine.ts';

// Pure policy-engine tests. No database, no Express.

const request = (overrides = {}) => ({
  id: 'req-1',
  action: 'send_email',
  params: {},
  context: {},
  status: 'pending',
  urgency: 'normal',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const policy = (overrides = {}) => ({
  id: 'policy-1',
  name: 'test policy',
  priority: 100,
  enabled: true,
  rules: [],
  ...overrides,
});

test('allow: a matching auto_approve rule approves and reports the rule', () => {
  const rule = { match: { action: 'send_email', 'params.to': { $regex: '@example\\.com$' } }, decision: 'auto_approve' };
  const result = evaluatePolicy(
    request({ params: { to: 'ops@example.com' } }),
    [policy({ rules: [rule] })]
  );
  assert.equal(result.decision, 'auto_approve');
  assert.equal(result.matchedRule, rule);
});

test('allow: numeric operator on a nested param approves under the threshold', () => {
  const result = evaluatePolicy(
    request({ action: 'issue_refund', params: { amount: 40 } }),
    [policy({ rules: [{ match: { action: 'issue_refund', 'params.amount': { $lte: 50 } }, decision: 'auto_approve' }] })]
  );
  assert.equal(result.decision, 'auto_approve');
});

test('deny: a matching auto_deny rule blocks the action', () => {
  const result = evaluatePolicy(
    request({ action: 'transfer_funds', params: { amount: 5000 } }),
    [policy({ rules: [{ match: { action: 'transfer_funds', 'params.amount': { $gt: 1000 } }, decision: 'auto_deny' }] })]
  );
  assert.equal(result.decision, 'auto_deny');
  assert.equal(result.approvers, undefined);
});

test('deny: exact-match on a top-level field denies', () => {
  const result = evaluatePolicy(
    request({ action: 'delete_records' }),
    [policy({ rules: [{ match: { action: 'delete_records' }, decision: 'auto_deny' }] })]
  );
  assert.equal(result.decision, 'auto_deny');
});

test('route-to-human: an explicit rule returns its approvers and channels', () => {
  const result = evaluatePolicy(
    request({ action: 'send_invoice', params: { amount: 900 } }),
    [policy({
      rules: [{
        match: { action: 'send_invoice' },
        decision: 'route_to_human',
        approvers: ['finance-lead'],
        channels: ['#approvals'],
      }],
    })]
  );
  assert.equal(result.decision, 'route_to_human');
  assert.deepEqual(result.approvers, ['finance-lead']);
  assert.deepEqual(result.channels, ['#approvals']);
});

test('route-to-human: no matching rule falls back to route_to_human with no matched rule', () => {
  const result = evaluatePolicy(
    request({ action: 'unknown_action' }),
    [policy({ rules: [{ match: { action: 'send_email' }, decision: 'auto_approve' }] })]
  );
  assert.equal(result.decision, 'route_to_human');
  assert.equal(result.matchedRule, undefined);
});

test('route-to-human: no policies at all defaults to human review', () => {
  assert.equal(evaluatePolicy(request(), []).decision, 'route_to_human');
});

test('regex safety: a safe pattern matches', () => {
  const result = evaluatePolicy(
    request({ action: 'send_email' }),
    [policy({ rules: [{ match: { action: { $regex: '^send_' } }, decision: 'auto_approve' }] })]
  );
  assert.equal(result.decision, 'auto_approve');
});

test('regex safety: a catastrophic-backtracking pattern is rejected and does not hang', () => {
  const evil = '^(a+)+$';
  const started = Date.now();
  const result = evaluatePolicy(
    request({ action: 'a'.repeat(28) + '!' }),
    [policy({ rules: [{ match: { action: { $regex: evil } }, decision: 'auto_approve' }] })]
  );
  const elapsed = Date.now() - started;
  assert.notEqual(result.decision, 'auto_approve', 'unsafe regex must not match');
  assert.equal(result.decision, 'route_to_human');
  assert.ok(elapsed < 1000, `evaluation took ${elapsed}ms`);
});

test('regex safety: an invalid pattern is a non-match, not an exception', () => {
  const result = evaluatePolicy(
    request({ action: 'send_email' }),
    [policy({ rules: [{ match: { action: { $regex: '[' } }, decision: 'auto_approve' }] })]
  );
  assert.equal(result.decision, 'route_to_human');
});

test('regex safety: $regex against a non-string value is a non-match', () => {
  const result = evaluatePolicy(
    request({ params: { count: 42 } }),
    [policy({ rules: [{ match: { 'params.count': { $regex: '^4' } }, decision: 'auto_approve' }] })]
  );
  assert.equal(result.decision, 'route_to_human');
});

test('precedence: lower priority number is evaluated first, regardless of array order', () => {
  const broadAllow = policy({ id: 'broad', priority: 200, rules: [{ match: { action: 'send_email' }, decision: 'auto_approve' }] });
  const specificDeny = policy({ id: 'specific', priority: 10, rules: [{ match: { action: 'send_email', 'params.external': true }, decision: 'auto_deny' }] });
  const result = evaluatePolicy(request({ params: { external: true } }), [broadAllow, specificDeny]);
  assert.equal(result.decision, 'auto_deny');
});

test('precedence: within a policy the first matching rule wins', () => {
  const result = evaluatePolicy(
    request({ params: { amount: 10 } }),
    [policy({
      rules: [
        { match: { 'params.amount': { $lt: 100 } }, decision: 'auto_approve' },
        { match: { 'params.amount': { $lt: 1000 } }, decision: 'route_to_human' },
      ],
    })]
  );
  assert.equal(result.decision, 'auto_approve');
});

test('precedence: a non-matching rule falls through to the next rule, then the next policy', () => {
  const result = evaluatePolicy(
    request({ action: 'post_update' }),
    [
      policy({ id: 'a', priority: 1, rules: [{ match: { action: 'send_email' }, decision: 'auto_deny' }] }),
      policy({ id: 'b', priority: 2, rules: [{ match: { action: 'send_email' }, decision: 'auto_deny' }, { match: { action: 'post_update' }, decision: 'auto_approve' }] }),
    ]
  );
  assert.equal(result.decision, 'auto_approve');
  assert.equal(result.matchedRule.decision, 'auto_approve');
});

test('precedence: disabled policies are skipped', () => {
  const result = evaluatePolicy(
    request(),
    [policy({ enabled: false, rules: [{ match: { action: 'send_email' }, decision: 'auto_approve' }] })]
  );
  assert.equal(result.decision, 'route_to_human');
});

test('scope: per_agent policy applies only to the verified agent id', () => {
  const scoped = policy({
    scope: 'per_agent',
    agentIds: ['agent-7'],
    rules: [{ match: { action: 'send_email' }, decision: 'auto_approve' }],
  });
  assert.equal(evaluatePolicy(request(), [scoped], { agentId: 'agent-7' }).decision, 'auto_approve');
  assert.equal(evaluatePolicy(request(), [scoped], { agentId: 'agent-8' }).decision, 'route_to_human');
});

test('scope: per_agent policy fails closed when no agent id is supplied', () => {
  const scoped = policy({
    scope: 'per_agent',
    agentIds: ['agent-7'],
    rules: [{ match: { action: 'send_email' }, decision: 'auto_approve' }],
  });
  assert.equal(evaluatePolicy(request(), [scoped]).decision, 'route_to_human');
  assert.equal(evaluatePolicy(request(), [scoped], { agentId: null }).decision, 'route_to_human');
});

test('scope: per_tool policy applies only when the tool is listed', () => {
  const scoped = policy({
    scope: 'per_tool',
    toolIds: ['send_email'],
    rules: [{ match: { action: { $regex: '.*' } }, decision: 'auto_deny' }],
  });
  assert.equal(evaluatePolicy(request({ action: 'send_email' }), [scoped], { tool: 'send_email' }).decision, 'auto_deny');
  assert.equal(evaluatePolicy(request({ action: 'read_file' }), [scoped], { tool: 'read_file' }).decision, 'route_to_human');
});
