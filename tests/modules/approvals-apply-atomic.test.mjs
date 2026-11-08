import test from 'node:test';
import assert from 'node:assert/strict';
import { applyApprovalDecision, messageUpdateFor } from '../../server/modules/approvals/apply-atomic.ts';

// Fake store. A transaction works on a copy of the state: commit replaces the state,
// rollback discards the copy. No database, no network.
function makeStore(seed) {
  let state = structuredClone(seed);
  const log = { committed: 0, rolledBack: 0 };
  const tx = (fail = {}) => ({
    async writeApprovalDecision(w, draft) {
      const row = draft.approvals.find((a) => a.id === w.approvalId && a.companyId === w.companyId);
      if (!row || row.status !== 'pending' || row.expiresAt <= w.decidedAt) return false;
      Object.assign(row, { status: w.decision, decidedBy: w.decidedBy, reason: w.reason, decidedAt: w.decidedAt });
      return true;
    },
    async writeMessageStatus(w, draft) {
      if (fail.message) throw new Error('simulated message write failure');
      const row = draft.messages.find((m) => m.id === w.messageId && m.companyId === w.companyId);
      if (!row || row.approvalId !== w.approvalId || row.status !== w.expectedStatus) return false;
      Object.assign(row, { status: w.nextStatus, skipReason: w.skipReason, updatedAt: w.updatedAt });
      return true;
    },
  });
  const runner = (fail) => ({
    async runInTransaction(callback) {
      const draft = structuredClone(state);
      const handle = tx(fail);
      // Bind the draft so each write sees the transaction's copy.
      const bound = {
        writeApprovalDecision: (w) => handle.writeApprovalDecision(w, draft),
        writeMessageStatus: (w) => handle.writeMessageStatus(w, draft),
      };
      try {
        const result = await callback(bound);
        state = draft;
        log.committed++;
        return result;
      } catch (err) {
        log.rolledBack++;
        throw err;
      }
    },
  });
  return { runner, read: () => structuredClone(state), log };
}

const T0 = new Date('2026-11-04T10:00:00Z');
const LATER = new Date(T0.getTime() + 60 * 60_000);

function seed({ approvalStatus = 'pending', expiresAt = LATER, messageStatus = 'awaiting_approval', messageApprovalId = 'ap-1' } = {}) {
  return {
    approvals: [{ id: 'ap-1', companyId: 'co-A', status: approvalStatus, expiresAt, decidedBy: null, reason: null, decidedAt: null }],
    messages: [{ id: 'msg-1', companyId: 'co-A', approvalId: messageApprovalId, status: messageStatus, skipReason: null, updatedAt: null }],
  };
}

const baseInput = { companyId: 'co-A', approvalId: 'ap-1', messageId: 'msg-1', decidedBy: 'dashboard:u-1', reason: 'ok' };
const deps = (store, extra = {}) => ({ transactions: store.runner(extra.fail ?? {}), now: () => T0, ...extra.deps });

test('approve moves the approval to approved and the message to queued together', async () => {
  const store = makeStore(seed());
  const res = await applyApprovalDecision(deps(store), { ...baseInput, decision: 'approved' });
  assert.equal(res.kind, 'applied');
  assert.equal(res.messageStatus, 'queued');
  const s = store.read();
  assert.equal(s.approvals[0].status, 'approved');
  assert.equal(s.approvals[0].decidedBy, 'dashboard:u-1');
  assert.equal(s.messages[0].status, 'queued');
  assert.equal(s.messages[0].skipReason, null);
  assert.equal(store.log.committed, 1);
});

test('reject moves the message to skipped with approval_rejected', async () => {
  const store = makeStore(seed());
  const res = await applyApprovalDecision(deps(store), { ...baseInput, decision: 'rejected' });
  assert.equal(res.kind, 'applied');
  const s = store.read();
  assert.equal(s.approvals[0].status, 'rejected');
  assert.equal(s.messages[0].status, 'skipped');
  assert.equal(s.messages[0].skipReason, 'approval_rejected');
});

test('when the message update throws, the approval write rolls back and the error propagates', async () => {
  const store = makeStore(seed());
  await assert.rejects(
    applyApprovalDecision(deps(store, { fail: { message: true } }), { ...baseInput, decision: 'approved' }),
    /simulated message write failure/
  );
  const s = store.read();
  assert.equal(s.approvals[0].status, 'pending', 'approval must stay pending');
  assert.equal(s.approvals[0].decidedBy, null);
  assert.equal(s.messages[0].status, 'awaiting_approval', 'message must stay unchanged');
  assert.equal(store.log.rolledBack, 1);
  assert.equal(store.log.committed, 0);
});

test('when the message is not awaiting approval, the approval stays pending', async () => {
  const store = makeStore(seed({ messageStatus: 'sent' }));
  const res = await applyApprovalDecision(deps(store), { ...baseInput, decision: 'approved' });
  assert.deepEqual(res, { kind: 'message_not_awaiting' });
  const s = store.read();
  assert.equal(s.approvals[0].status, 'pending');
  assert.equal(s.messages[0].status, 'sent');
  assert.equal(store.log.rolledBack, 1);
});

test('when the message belongs to another approval, nothing is written', async () => {
  const store = makeStore(seed({ messageApprovalId: 'ap-other' }));
  const res = await applyApprovalDecision(deps(store), { ...baseInput, decision: 'approved' });
  assert.deepEqual(res, { kind: 'message_not_awaiting' });
  assert.equal(store.read().approvals[0].status, 'pending');
});

test('an approval that is already decided is refused before the message is touched', async () => {
  const store = makeStore(seed({ approvalStatus: 'approved' }));
  const res = await applyApprovalDecision(deps(store), { ...baseInput, decision: 'rejected' });
  assert.deepEqual(res, { kind: 'approval_not_pending' });
  const s = store.read();
  assert.equal(s.approvals[0].status, 'approved');
  assert.equal(s.messages[0].status, 'awaiting_approval');
});

test('an expired approval is refused', async () => {
  const store = makeStore(seed({ expiresAt: new Date(T0.getTime() - 1) }));
  const res = await applyApprovalDecision(deps(store), { ...baseInput, decision: 'approved' });
  assert.deepEqual(res, { kind: 'approval_not_pending' });
  assert.equal(store.read().messages[0].status, 'awaiting_approval');
});

test('an approval from another company is treated as missing', async () => {
  const store = makeStore(seed());
  const res = await applyApprovalDecision(deps(store), { ...baseInput, companyId: 'co-B', decision: 'approved' });
  assert.deepEqual(res, { kind: 'approval_not_pending' });
  assert.equal(store.read().approvals[0].status, 'pending');
});

test('a missing company id fails closed before any transaction opens', async () => {
  const store = makeStore(seed());
  await assert.rejects(applyApprovalDecision(deps(store), { ...baseInput, companyId: '', decision: 'approved' }), TypeError);
  assert.equal(store.log.committed + store.log.rolledBack, 0);
});

test('an invalid decision is refused before any transaction opens', async () => {
  const store = makeStore(seed());
  await assert.rejects(applyApprovalDecision(deps(store), { ...baseInput, decision: 'pending' }), TypeError);
  assert.equal(store.log.committed + store.log.rolledBack, 0);
});

test('an over-long reason is refused', async () => {
  const store = makeStore(seed());
  await assert.rejects(
    applyApprovalDecision(deps(store), { ...baseInput, decision: 'approved', reason: 'x'.repeat(501) }),
    TypeError
  );
});

test('afterCommit runs once on success and not on rollback', async () => {
  const seen = [];
  const okStore = makeStore(seed());
  await applyApprovalDecision(
    deps(okStore, { deps: { afterCommit: async (a) => { seen.push(a); } } }),
    { ...baseInput, decision: 'approved' }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messageStatus, 'queued');

  const failStore = makeStore(seed());
  const hooks = [];
  await assert.rejects(applyApprovalDecision(
    deps(failStore, { fail: { message: true }, deps: { afterCommit: async (a) => { hooks.push(a); } } }),
    { ...baseInput, decision: 'approved' }
  ));
  assert.equal(hooks.length, 0);
});

test('messageUpdateFor maps decisions to the matching message update', () => {
  assert.deepEqual(messageUpdateFor('approved'), { nextStatus: 'queued', skipReason: null });
  assert.deepEqual(messageUpdateFor('rejected'), { nextStatus: 'skipped', skipReason: 'approval_rejected' });
});
