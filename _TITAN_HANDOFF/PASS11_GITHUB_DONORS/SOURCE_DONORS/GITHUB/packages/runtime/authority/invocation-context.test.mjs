import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvocationEnvelope, DurableAgentContextOwner, createHandoffReceipt, HandoffReceiptInbox } from './invocation-context.mjs';

const base = { company_id:'co-1', invocation_id:'invoke-1', actor_id:'agent-a', correlation_id:'corr-1', context_ref:'ctx-1', context_revision:'7', authority_ceiling:['jobs.read','jobs.update'], issued_at:'2026-01-01T00:00:00.000Z' };
const context = { company_id:'co-1', context_ref:'ctx-1', revision:'7', source_actor:'agent-a', provenance_ref:'prov-1', observed_at:'2026-01-01T00:00:00.000Z', retained_until:'2027-01-01T00:00:00.000Z' };
const root = { delegation_id:'del-root', parent_decision_id:'root', child_decision_id:'invoke-1', delegated_at:'2026-01-01T00:00:00.000Z', depth:1, parent_status:'verified', capability:'jobs.update', workflow:'dispatch', context_ref:'ctx-1' };
const child = { delegation_id:'del-child', parent_decision_id:'invoke-1', child_decision_id:'invoke-2', parent_delegation_id:'del-root', delegated_at:'2026-01-01T00:00:01.000Z', depth:2, parent_status:'verified', capability:'jobs.update', workflow:'dispatch', context_ref:'ctx-1' };

test('invocation envelope preserves chain references and never confers authority', () => {
  const envelope = createInvocationEnvelope(base);
  assert.equal(envelope.schema, 'titan.agent.invocation/v1'); assert.equal(envelope.authority_effect, false); assert.equal(envelope.correlation_id, 'corr-1');
});

test('context owner is company scoped, revision stable, and revocable', () => {
  const owner = new DurableAgentContextOwner(); const stored = owner.put(context); assert.equal(owner.put(context), stored);
  assert.throws(() => owner.resolve('co-2', 'ctx-1'), /context-not-found/); owner.revoke('co-1', 'ctx-1'); assert.throws(() => owner.resolve('co-1', 'ctx-1'), /context-revoked/);
});

test('handoff receipt preserves causation, context reference, and delegation continuity', () => {
  const parent = createInvocationEnvelope(base); const next = createInvocationEnvelope({ ...base, invocation_id:'invoke-2', actor_id:'agent-b', causation_id:'invoke-1', parent_invocation_id:'invoke-1' });
  const receipt = createHandoffReceipt({ handoff_id:'handoff-1', from_invocation:parent, to_invocation:next, parent_delegation:root, delegation:child });
  assert.equal(receipt.authority_effect, false); assert.equal(receipt.context_ref, 'ctx-1');
});

test('handoff inbox is idempotent and revalidates context', () => {
  const owner = new DurableAgentContextOwner(); owner.put(context); const inbox = new HandoffReceiptInbox();
  const parent = createInvocationEnvelope(base); const next = createInvocationEnvelope({ ...base, invocation_id:'invoke-2', causation_id:'invoke-1', parent_invocation_id:'invoke-1' });
  const receipt = createHandoffReceipt({ handoff_id:'handoff-2', from_invocation:parent, to_invocation:next, parent_delegation:root, delegation:child });
  assert.equal(inbox.accept(receipt, owner).duplicate, false); assert.equal(inbox.accept(receipt, owner).duplicate, true); owner.revoke('co-1', 'ctx-1');
  assert.throws(() => inbox.accept({ ...receipt, handoff_id:'handoff-3' }, owner), /context-revoked/);
});

test('handoff rejects cross-company and authority-ceiling expansion', () => {
  const parent = createInvocationEnvelope(base); const next = createInvocationEnvelope({ ...base, invocation_id:'invoke-2', causation_id:'invoke-1', parent_invocation_id:'invoke-1', authority_ceiling:['jobs.read','jobs.update','jobs.delete'] });
  assert.throws(() => createHandoffReceipt({ handoff_id:'handoff-4', from_invocation:parent, to_invocation:next, parent_delegation:root, delegation:child }), /handoff-authority-ceiling-expansion/);
  assert.throws(() => createHandoffReceipt({ handoff_id:'handoff-5', from_invocation:parent, to_invocation:{ ...next, company_id:'co-2' }, parent_delegation:root, delegation:{ ...child, company_id:'co-2' } }), /handoff-company-mismatch|authority-delegation-company-mismatch/);
});

