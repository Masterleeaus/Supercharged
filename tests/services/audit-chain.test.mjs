import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAuditHash,
  canonicalJson,
  verifyAuditChain,
} from '../../server/services/audit-chain.mjs';

const base = {
  action: 'approval.requested',
  userId: 'user-1',
  targetUserId: null,
  resourceType: 'approval',
  resourceId: 'appr-1',
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  metadata: { amount: 10, tags: ['a', 'b'] },
  severity: 'info',
  timestamp: '2026-11-02T00:00:00.000Z',
};

test('computeAuditHash is deterministic and returns sha256 hex', () => {
  const a = computeAuditHash(base, null);
  const b = computeAuditHash({ ...base }, null);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('computeAuditHash ignores object key order inside metadata', () => {
  const reordered = {
    ...base,
    metadata: { tags: ['a', 'b'], amount: 10 },
  };
  assert.equal(computeAuditHash(base, 'prev'), computeAuditHash(reordered, 'prev'));
});

test('computeAuditHash treats undefined optional fields as null', () => {
  const sparse = { action: 'policy.evaluated', timestamp: base.timestamp };
  const explicit = {
    action: 'policy.evaluated',
    timestamp: base.timestamp,
    userId: null,
    targetUserId: null,
    resourceType: null,
    resourceId: null,
    ipAddress: null,
    userAgent: null,
    metadata: null,
    severity: null,
  };
  assert.equal(computeAuditHash(sparse, null), computeAuditHash(explicit, null));
});

test('computeAuditHash is sensitive to the previous hash', () => {
  const h1 = computeAuditHash(base, 'a'.repeat(64));
  const h2 = computeAuditHash(base, 'b'.repeat(64));
  const genesis = computeAuditHash(base, null);
  assert.notEqual(h1, h2);
  assert.notEqual(h1, genesis);
  assert.notEqual(h2, genesis);
});

test('computeAuditHash rejects a non-string, non-null prevHash', () => {
  assert.throws(() => computeAuditHash(base, 42), TypeError);
});

test('computeAuditHash detects tampering with any hashed field', () => {
  const original = computeAuditHash(base, null);
  const tampered = [
    { ...base, action: 'approval.approved' },
    { ...base, userId: 'user-2' },
    { ...base, resourceId: 'appr-2' },
    { ...base, severity: 'critical' },
    { ...base, timestamp: '2026-11-02T00:00:01.000Z' },
    { ...base, metadata: { amount: 11, tags: ['a', 'b'] } },
  ];
  for (const entry of tampered) {
    assert.notEqual(computeAuditHash(entry, null), original);
  }
});

test('canonicalJson sorts keys recursively and drops undefined', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } }),
    '{"a":{"c":[{"y":2,"z":1}]},"b":1}',
  );
});

function buildChain(entries) {
  const rows = [];
  let prev = null;
  for (const entry of entries) {
    const entryHash = computeAuditHash(entry, prev);
    rows.push({ ...entry, prevHash: prev, entryHash });
    prev = entryHash;
  }
  return rows;
}

const entries = [
  { ...base, action: 'approval.requested', timestamp: '2026-11-02T00:00:00.000Z' },
  { ...base, action: 'approval.approved', userId: 'approver-1', timestamp: '2026-11-02T00:01:00.000Z' },
  { ...base, action: 'approval.executed', timestamp: '2026-11-02T00:02:00.000Z' },
];

test('verifyAuditChain accepts an untouched chain', () => {
  assert.deepEqual(verifyAuditChain(buildChain(entries)), { valid: true });
});

test('verifyAuditChain detects an edited row', () => {
  const rows = buildChain(entries);
  rows[1] = { ...rows[1], userId: 'attacker' };
  assert.deepEqual(verifyAuditChain(rows), { valid: false, index: 1 });
});

test('verifyAuditChain detects a removed row', () => {
  const rows = buildChain(entries);
  rows.splice(1, 1);
  assert.deepEqual(verifyAuditChain(rows), { valid: false, index: 1 });
});
