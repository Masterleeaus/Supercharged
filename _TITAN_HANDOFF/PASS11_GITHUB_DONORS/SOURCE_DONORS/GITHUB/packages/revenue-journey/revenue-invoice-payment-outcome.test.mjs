import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRevenueJourneyCorrelation } from './revenue-journey-correlation.mjs';
import {
 buildInvoicePaymentLifecycleObservation,
 verifyInvoicePaymentOutcome,
} from './revenue-invoice-payment-lifecycle.mjs';

const base = {
 company_id: 'co-263',
 invoice_id: 'invoice-1',
 invoice_state: 'paid',
 payment_id: 'payment-1',
 payment_state: 'settled',
 amount_total: 100,
 amount_paid: 100,
 amount_refunded: 0,
 provenance: {
  producer: 'payment-provider',
  source_event_id: 'provider-event-1',
  observed_at: '2026-09-29T00:00:00.000Z',
 },
 evidence_refs: ['provider-event-1'],
 correlation: buildRevenueJourneyCorrelation({
  company_id: 'co-263',
  invoice_id: 'invoice-1',
  payment_id: 'payment-1',
  provenance: {
   producer: 'payment-provider',
   source_event_id: 'provider-event-1',
   observed_at: '2026-09-29T00:00:00.000Z',
  },
 }),
};

test('provider acknowledgement alone cannot create a verified financial outcome', () => {
 const observation = buildInvoicePaymentLifecycleObservation(base);
 assert.throws(
  () => verifyInvoicePaymentOutcome(observation, {
   company_id: 'co-263',
   provider_acknowledged: true,
   verified_evidence_refs: ['provider-event-1'],
   verified_at: '2026-09-29T00:01:00.000Z',
  }),
  /provider-ack-is-not-verification/,
 );
});

test('authoritative reread plus verification evidence produces a non-authoritative verified outcome', () => {
 const observation = buildInvoicePaymentLifecycleObservation(base);
 const outcome = verifyInvoicePaymentOutcome(observation, {
  company_id: 'co-263',
  provider_acknowledged: true,
  authoritative_reread: true,
  verified_evidence_refs: ['ledger-reread-1'],
  verified_at: '2026-09-29T00:01:00.000Z',
 });
 assert.equal(outcome.status, 'VERIFIED');
 assert.equal(outcome.authoritative_reread, true);
 assert.equal(outcome.governance.authority_granted, false);
 assert.equal(outcome.governance.execution_permitted, false);
});

test('verification is company-scoped and rejects incomplete settlement', () => {
 const observation = buildInvoicePaymentLifecycleObservation(base);
 assert.throws(
  () => verifyInvoicePaymentOutcome(observation, {
   company_id: 'co-other',
   authoritative_reread: true,
   verified_evidence_refs: ['ledger-reread-1'],
   verified_at: '2026-09-29T00:01:00.000Z',
  }),
  /cross-company/,
 );
});
