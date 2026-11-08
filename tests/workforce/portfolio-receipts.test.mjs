/**
 * Smart Task execution receipts (handoff sections 7, 8 P0, 11): approval and capability gates, idempotent
 * replay, uncertain-on-timeout, verified success, unverified on failed verification, and the retry bound
 * with dead-lettering.
 *
 * Uses in-memory fakes for the receipt store, provider executor, state verifier and timers. No database,
 * network, real provider or real timers.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/portfolio-receipts.test.mjs
 */
for (const level of ['log', 'info', 'warn']) console[level] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, verify, isTerminal } from '../../server/workforce/portfolio/receipts.ts';

const CAP = 'integration.reconnect';
const NOW = '2026-11-04T00:00:00.000Z';
const now = () => NOW;

const neverFires = () => ({ cancel() {} });
const firesNow = (_ms, onFire) => {
  onFire();
  return { cancel() {} };
};
const HANG = () => new Promise(() => {});

function approvedDecision(overrides = {}) {
  return {
    decision_id: 'dec-1',
    business_id: 'biz-1',
    status: 'approved',
    execution_capability: CAP,
    idempotency_key: 'key-1',
    ...overrides,
  };
}

function memoryStore({ seed = [], failPut = false } = {}) {
  const data = new Map(seed.map((r) => [r.idempotency_key, structuredClone(r)]));
  const puts = [];
  return {
    puts,
    data,
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    async put(receipt) {
      if (failPut) throw new Error('store unavailable');
      puts.push(structuredClone(receipt));
      data.set(receipt.idempotency_key, structuredClone(receipt));
    },
  };
}

function makeExecutor({
  invoke = async () => ({ ok: true, evidence_ref: 'provider-ev' }),
  read = async () => ({ passed: true, evidence_ref: 'verify-ev' }),
  maxAttempts = 3,
  schedule = neverFires,
  capability = CAP,
} = {}) {
  const calls = [];
  const reads = [];
  return {
    calls,
    reads,
    executor: {
      capability,
      maxAttempts,
      timeoutMs: 50,
      schedule,
      invoke: async (request) => {
        calls.push(request);
        return invoke(request, calls.length);
      },
      verifier: {
        read: async (decision) => {
          reads.push(decision);
          return read(decision, reads.length);
        },
      },
    },
  };
}

test('unapproved decision is refused with no provider call and no store write', async () => {
  const { executor, calls } = makeExecutor();
  const store = memoryStore();
  const result = await execute(approvedDecision({ status: 'awaiting_approval' }), executor, store, now);
  assert.deepEqual(result, { refused: true, reason: 'not_approved' });
  assert.equal(calls.length, 0);
  assert.equal(store.puts.length, 0);
});

test('capability mismatch is refused with no provider call', async () => {
  const { executor, calls } = makeExecutor({ capability: 'dns.repair' });
  const store = memoryStore();
  const result = await execute(approvedDecision(), executor, store, now);
  assert.deepEqual(result, { refused: true, reason: 'capability_mismatch' });
  assert.equal(calls.length, 0);
  assert.equal(store.puts.length, 0);
});

test('second execute with the same key returns the stored receipt and makes no provider call', async () => {
  const { executor, calls } = makeExecutor();
  const store = memoryStore();
  const first = await execute(approvedDecision(), executor, store, now);
  const second = await execute(approvedDecision(), executor, store, now);
  assert.equal(first.refused, false);
  assert.equal(second.refused, false);
  assert.equal(second.receipt.outcome, 'succeeded');
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(calls.length, 1);
});

test('provider timeout is recorded as uncertain, never as success or failure', async () => {
  const { executor, calls, reads } = makeExecutor({ invoke: HANG, schedule: firesNow });
  const store = memoryStore();
  const result = await execute(approvedDecision(), executor, store, now);
  const r = result.receipt;
  assert.equal(r.outcome, 'uncertain');
  assert.equal(r.status, 'settled');
  assert.equal(r.reason, 'provider_timeout');
  assert.equal(r.must_verify_before_retry, true);
  assert.equal(r.evidence_ref, null);
  assert.equal(calls.length, 1);
  assert.equal(reads.length, 0);
  assert.equal(isTerminal(r), true);

  // An uncertain receipt is terminal: a retry call does not reach the provider.
  const again = await execute(approvedDecision(), executor, store, now);
  assert.equal(again.receipt.outcome, 'uncertain');
  assert.equal(calls.length, 1);
});

test('provider success with failed verification is recorded as unverified, not succeeded', async () => {
  const { executor, calls, reads } = makeExecutor({
    read: async () => ({ passed: false, evidence_ref: 'stale-read' }),
  });
  const store = memoryStore();
  const result = await execute(approvedDecision(), executor, store, now);
  assert.equal(result.receipt.outcome, 'unverified');
  assert.equal(result.receipt.reason, 'state_mismatch');
  assert.notEqual(result.receipt.outcome, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(reads.length, 1);
});

test('verified provider success is recorded as succeeded with a full receipt', async () => {
  const { executor } = makeExecutor();
  const store = memoryStore();
  const { receipt } = await execute(approvedDecision(), executor, store, now);
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.status, 'settled');
  assert.equal(receipt.decision_id, 'dec-1');
  assert.equal(receipt.business_id, 'biz-1');
  assert.equal(receipt.capability, CAP);
  assert.equal(receipt.idempotency_key, 'key-1');
  assert.equal(receipt.attempt_count, 1);
  assert.equal(receipt.evidence_ref, 'verify-ev');
  assert.equal(receipt.must_verify_before_retry, false);
  assert.equal(receipt.created_at, NOW);
  assert.equal(receipt.last_attempt_at, NOW);
  assert.equal(receipt.settled_at, NOW);
});

test('retry bound reached dead-letters the receipt and it is never retried', async () => {
  const { executor, calls } = makeExecutor({
    invoke: async () => ({ ok: false }),
    maxAttempts: 2,
  });
  const store = memoryStore();
  const first = await execute(approvedDecision(), executor, store, now);
  assert.equal(first.receipt.outcome, 'failed');
  assert.equal(first.receipt.status, 'settled');
  assert.equal(first.receipt.attempt_count, 1);
  assert.equal(isTerminal(first.receipt), false);

  const second = await execute(approvedDecision(), executor, store, now);
  assert.equal(second.receipt.status, 'dead_lettered');
  assert.equal(second.receipt.outcome, 'failed');
  assert.equal(second.receipt.attempt_count, 2);
  assert.equal(calls.length, 2);

  const third = await execute(approvedDecision(), executor, store, now);
  assert.equal(third.receipt.status, 'dead_lettered');
  assert.equal(calls.length, 2);
});

test('a failed attempt retried with the same key can succeed on a later attempt', async () => {
  const { executor, calls } = makeExecutor({
    invoke: async (_req, n) => (n === 1 ? { ok: false } : { ok: true, evidence_ref: 'p2' }),
  });
  const store = memoryStore();
  await execute(approvedDecision(), executor, store, now);
  const retried = await execute(approvedDecision(), executor, store, now);
  assert.equal(retried.receipt.outcome, 'succeeded');
  assert.equal(retried.receipt.attempt_count, 2);
  assert.equal(calls[1].attempt, 2);
  assert.equal(calls[1].idempotency_key, 'key-1');
});

test('a thrown provider error is recorded as uncertain and is not retried', async () => {
  const { executor, calls } = makeExecutor({
    invoke: async () => {
      throw new Error('provider 500 with payload');
    },
  });
  const store = memoryStore();
  const { receipt } = await execute(approvedDecision(), executor, store, now);
  assert.equal(receipt.outcome, 'uncertain');
  assert.equal(receipt.reason, 'provider_error');
  assert.equal(receipt.must_verify_before_retry, true);
  assert.equal(JSON.stringify(receipt).includes('payload'), false);
  await execute(approvedDecision(), executor, store, now);
  assert.equal(calls.length, 1);
});

test('a receipt left in_progress by an interrupted worker is treated as uncertain without a provider call', async () => {
  const seeded = {
    decision_id: 'dec-1',
    business_id: 'biz-1',
    capability: CAP,
    idempotency_key: 'key-1',
    attempt_count: 1,
    status: 'in_progress',
    outcome: null,
    evidence_ref: null,
    reason: null,
    must_verify_before_retry: false,
    created_at: NOW,
    updated_at: NOW,
    last_attempt_at: NOW,
    settled_at: null,
  };
  const { executor, calls } = makeExecutor();
  const store = memoryStore({ seed: [seeded] });
  const { receipt } = await execute(approvedDecision(), executor, store, now);
  assert.equal(receipt.outcome, 'uncertain');
  assert.equal(receipt.must_verify_before_retry, true);
  assert.equal(calls.length, 0);
});

test('a verifier that throws leaves the receipt unverified', async () => {
  const { executor } = makeExecutor({
    read: async () => {
      throw new Error('db down');
    },
  });
  const store = memoryStore();
  const { receipt } = await execute(approvedDecision(), executor, store, now);
  assert.equal(receipt.outcome, 'unverified');
  assert.equal(receipt.reason, 'verification_error');
});

test('reusing a key for a different decision is refused without a provider call', async () => {
  const seeded = {
    decision_id: 'other-decision',
    business_id: 'biz-1',
    capability: CAP,
    idempotency_key: 'key-1',
    attempt_count: 1,
    status: 'settled',
    outcome: 'succeeded',
    evidence_ref: 'x',
    reason: null,
    must_verify_before_retry: false,
    created_at: NOW,
    updated_at: NOW,
    last_attempt_at: NOW,
    settled_at: NOW,
  };
  const { executor, calls } = makeExecutor();
  const store = memoryStore({ seed: [seeded] });
  const result = await execute(approvedDecision(), executor, store, now);
  assert.deepEqual(result, { refused: true, reason: 'idempotency_key_conflict' });
  assert.equal(calls.length, 0);
});

test('if the in_progress write fails, the provider is never called and the error propagates', async () => {
  const { executor, calls } = makeExecutor();
  const store = memoryStore({ failPut: true });
  await assert.rejects(execute(approvedDecision(), executor, store, now), /store unavailable/);
  assert.equal(calls.length, 0);
});

test('verify() passes only on a strict passed === true read', async () => {
  const decision = approvedDecision();
  const ok = await verify(decision, { ok: true, evidence_ref: 'p' }, { read: async () => ({ passed: 'yes', evidence_ref: 'v' }) }, { timeoutMs: 10 });
  assert.equal(ok.outcome, 'unverified');
  const pass = await verify(decision, { ok: true, evidence_ref: 'p' }, { read: async () => ({ passed: true, evidence_ref: null }) }, { timeoutMs: 10 });
  assert.equal(pass.outcome, 'succeeded');
  assert.equal(pass.evidence_ref, 'p');
});
