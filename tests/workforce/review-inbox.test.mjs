/**
 * Tests for server/workforce/runtime/review-inbox.ts. Pure input arrays, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/review-inbox.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewInbox } from '../../server/workforce/runtime/review-inbox.ts';

const CO_A = 'company-a';
const CO_B = 'company-b';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const now = () => NOW;
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const approval = (over) => ({ id: 'ap-1', companyId: CO_A, agentId: 'agent-1', runId: 'run-1', status: 'pending', createdAt: ago(10 * HOUR), ...over });
const run = (over) => ({ id: 'run-1', companyId: CO_A, agentId: 'agent-1', status: 'running', createdAt: ago(2 * HOUR), ...over });
const call = (over) => ({ id: 'tc-1', companyId: CO_A, runId: 'run-1', agentId: 'agent-1', toolId: 'send_email', outcome: 'executed', createdAt: ago(HOUR), ...over });

test('no inputs produce an empty inbox', () => {
  assert.deepEqual(buildReviewInbox({ companyId: CO_A, approvals: [], runs: [], toolCalls: [] }, { now }), []);
});

test('an empty companyId returns nothing', () => {
  const out = buildReviewInbox({ companyId: '', approvals: [approval({ companyId: '' })], runs: [], toolCalls: [] }, { now });
  assert.deepEqual(out, []);
});

test('approval_pending is produced for a pending approval older than the threshold, as medium', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [approval({ createdAt: ago(10 * HOUR) })], runs: [], toolCalls: [] }, { now, approvalPendingAfterMs: 4 * HOUR });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'approval_pending');
  assert.equal(out[0].severity, 'medium');
  assert.equal(out[0].approvalId, 'ap-1');
  assert.equal(out[0].agentId, 'agent-1');
  assert.equal(out[0].runId, 'run-1');
  assert.equal(out[0].companyId, CO_A);
  assert.equal(out[0].createdAt, ago(10 * HOUR));
});

test('a pending approval younger than the threshold is not flagged', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [approval({ createdAt: ago(HOUR) })], runs: [], toolCalls: [] }, { now, approvalPendingAfterMs: 4 * HOUR });
  assert.deepEqual(out, []);
});

test('approval_pending threshold is strict: exactly at the threshold is not flagged', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [approval({ createdAt: ago(4 * HOUR) })], runs: [], toolCalls: [] }, { now, approvalPendingAfterMs: 4 * HOUR });
  assert.deepEqual(out, []);
});

test('approval_pending uses the 4 hour default when no threshold is given', () => {
  const young = buildReviewInbox({ companyId: CO_A, approvals: [approval({ createdAt: ago(3 * HOUR) })], runs: [], toolCalls: [] }, { now });
  const old = buildReviewInbox({ companyId: CO_A, approvals: [approval({ createdAt: ago(5 * HOUR) })], runs: [], toolCalls: [] }, { now });
  assert.equal(young.length, 0);
  assert.equal(old.length, 1);
});

test('approval_expired_unhandled is produced for an expired approval nobody handled, as low', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [approval({ status: 'expired' })], runs: [], toolCalls: [] }, { now });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'approval_expired_unhandled');
  assert.equal(out[0].severity, 'low');
});

test('an expired approval that was handled is not flagged', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [approval({ status: 'expired', handled: true })], runs: [], toolCalls: [] }, { now });
  assert.deepEqual(out, []);
});

test('approved and rejected approvals are never flagged', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [approval({ id: 'a', status: 'approved' }), approval({ id: 'b', status: 'rejected' })],
    runs: [],
    toolCalls: [],
  }, { now });
  assert.deepEqual(out, []);
});

test('run_needs_attention is produced for a failed run, as high', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [], runs: [run({ status: 'failed' })], toolCalls: [] }, { now });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'run_needs_attention');
  assert.equal(out[0].severity, 'high');
  assert.equal(out[0].runId, 'run-1');
});

test('run_needs_attention is produced for awaiting_approval past the threshold, as low', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [run({ status: 'awaiting_approval', updatedAt: ago(2 * HOUR) })],
    toolCalls: [],
  }, { now, runAwaitingAfterMs: HOUR });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'run_needs_attention');
  assert.equal(out[0].severity, 'low');
  assert.equal(out[0].createdAt, ago(2 * HOUR));
});

test('awaiting_approval within the threshold is not flagged', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [run({ status: 'awaiting_approval', updatedAt: ago(30 * 60 * 1000) })],
    toolCalls: [],
  }, { now, runAwaitingAfterMs: HOUR });
  assert.deepEqual(out, []);
});

test('awaiting_approval falls back to createdAt when updatedAt is missing', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [run({ status: 'awaiting_approval', createdAt: ago(3 * HOUR) })],
    toolCalls: [],
  }, { now, runAwaitingAfterMs: 2 * HOUR });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'run_needs_attention');
});

test('running and completed runs are never flagged', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [run({ id: 'r1', status: 'running' }), run({ id: 'r2', status: 'completed' })],
    toolCalls: [],
  }, { now });
  assert.deepEqual(out, []);
});

test('tool_failed is produced for a failed tool call, as high', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [], runs: [], toolCalls: [call({ outcome: 'failed' })] }, { now });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_failed');
  assert.equal(out[0].severity, 'high');
  assert.equal(out[0].id, 'tool_failed:tc-1');
});

test('tool_failed is also produced for an uncertain tool call, as high', () => {
  const out = buildReviewInbox({ companyId: CO_A, approvals: [], runs: [], toolCalls: [call({ outcome: 'uncertain' })] }, { now });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_failed');
  assert.equal(out[0].severity, 'high');
  assert.match(out[0].reason, /uncertain/);
});

test('policy_conflict is produced for a refusal mentioning policy or company_rule, as low', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [],
    toolCalls: [
      call({ id: 'p1', outcome: 'refused', reason: 'policy_denied' }),
      call({ id: 'p2', outcome: 'refused', reason: 'company_rule_blocked' }),
    ],
  }, { now });
  assert.deepEqual(out.map((i) => i.kind), ['policy_conflict', 'policy_conflict']);
  assert.deepEqual(out.map((i) => i.severity), ['low', 'low']);
});

test('a refusal without policy or company_rule in the reason is not a policy_conflict', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [],
    toolCalls: [call({ outcome: 'refused', reason: 'approval_expired' })],
  }, { now });
  assert.deepEqual(out, []);
});

test('executed and awaiting_approval tool calls are not flagged', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [],
    toolCalls: [call({ id: 'x', outcome: 'executed' }), call({ id: 'y', outcome: 'awaiting_approval' })],
  }, { now });
  assert.deepEqual(out, []);
});

test('every kind is produced from the right input', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [approval({ id: 'ap-p' }), approval({ id: 'ap-e', status: 'expired' })],
    runs: [run({ id: 'run-f', status: 'failed' })],
    toolCalls: [call({ id: 'tc-f', outcome: 'failed' }), call({ id: 'tc-r', outcome: 'refused', reason: 'policy_block' })],
  }, { now, approvalPendingAfterMs: 4 * HOUR });
  const kinds = new Set(out.map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), ['approval_expired_unhandled', 'approval_pending', 'policy_conflict', 'run_needs_attention', 'tool_failed']);
});

test('rows belonging to another company are excluded from every input', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [approval({ id: 'b-ap', companyId: CO_B })],
    runs: [run({ id: 'b-run', companyId: CO_B, status: 'failed' })],
    toolCalls: [call({ id: 'b-tc', companyId: CO_B, outcome: 'failed' }), call({ id: 'b-pol', companyId: CO_B, outcome: 'refused', reason: 'policy' })],
  }, { now });
  assert.deepEqual(out, []);
});

test('only the requested company appears when both companies have exceptions', () => {
  const out = buildReviewInbox({
    companyId: CO_B,
    approvals: [approval({ id: 'a-ap', companyId: CO_A }), approval({ id: 'b-ap', companyId: CO_B })],
    runs: [run({ id: 'a-run', companyId: CO_A, status: 'failed' })],
    toolCalls: [call({ id: 'a-tc', companyId: CO_A, outcome: 'failed' }), call({ id: 'b-tc', companyId: CO_B, outcome: 'uncertain' })],
  }, { now });
  assert.deepEqual(out.map((i) => i.id), ['tool_failed:b-tc', 'approval_pending:b-ap']);
  assert.ok(out.every((i) => i.companyId === CO_B));
});

test('a row with no companyId is not returned for any company', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [],
    toolCalls: [{ id: 'orphan', outcome: 'failed', createdAt: ago(HOUR) }],
  }, { now });
  assert.deepEqual(out, []);
});

test('output is sorted by severity first, high before medium before low', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [
      approval({ id: 'ap-med', createdAt: ago(20 * HOUR) }),
      approval({ id: 'ap-low', status: 'expired', createdAt: ago(30 * HOUR) }),
    ],
    runs: [],
    toolCalls: [
      call({ id: 'tc-high', outcome: 'failed', createdAt: ago(HOUR) }),
      call({ id: 'tc-low', outcome: 'refused', reason: 'policy', createdAt: ago(40 * HOUR) }),
    ],
  }, { now });
  assert.deepEqual(out.map((i) => i.severity), ['high', 'medium', 'low', 'low']);
  assert.equal(out[0].kind, 'tool_failed');
  assert.equal(out[1].kind, 'approval_pending');
});

test('within one severity, items are sorted by createdAt, oldest first', () => {
  const out = buildReviewInbox({
    companyId: CO_A,
    approvals: [],
    runs: [],
    toolCalls: [
      call({ id: 'newer', outcome: 'failed', createdAt: ago(HOUR) }),
      call({ id: 'older', outcome: 'failed', createdAt: ago(5 * HOUR) }),
      call({ id: 'middle', outcome: 'uncertain', createdAt: ago(3 * HOUR) }),
    ],
  }, { now });
  assert.deepEqual(out.map((i) => i.id), ['tool_failed:older', 'tool_failed:middle', 'tool_failed:newer']);
});

test('the input arrays are not mutated', () => {
  const approvals = [approval({ id: 'z', createdAt: ago(10 * HOUR) }), approval({ id: 'a', createdAt: ago(10 * HOUR) })];
  const snapshot = JSON.stringify(approvals);
  buildReviewInbox({ companyId: CO_A, approvals, runs: [], toolCalls: [] }, { now });
  assert.equal(JSON.stringify(approvals), snapshot);
});

test('the injected now controls the outcome: the same approval flips once the threshold passes', () => {
  const approvals = [approval({ createdAt: ago(3 * HOUR) })];
  const earlier = buildReviewInbox({ companyId: CO_A, approvals, runs: [], toolCalls: [] }, { now: () => NOW, approvalPendingAfterMs: 2 * HOUR });
  const later = buildReviewInbox({ companyId: CO_A, approvals, runs: [], toolCalls: [] }, { now: () => new Date(NOW.getTime() + 2 * HOUR), approvalPendingAfterMs: 2 * HOUR });
  assert.equal(earlier.length, 1);
  assert.equal(later.length, 1);
  const notYet = buildReviewInbox({ companyId: CO_A, approvals, runs: [], toolCalls: [] }, { now: () => new Date(NOW.getTime() - HOUR), approvalPendingAfterMs: 2 * HOUR });
  assert.equal(notYet.length, 0);
});

test('items carry the documented fields', () => {
  const [item] = buildReviewInbox({ companyId: CO_A, approvals: [], runs: [], toolCalls: [call({ outcome: 'failed' })] }, { now });
  assert.deepEqual(Object.keys(item).sort(), ['agentId', 'companyId', 'createdAt', 'id', 'kind', 'reason', 'runId', 'severity'].sort());
});
