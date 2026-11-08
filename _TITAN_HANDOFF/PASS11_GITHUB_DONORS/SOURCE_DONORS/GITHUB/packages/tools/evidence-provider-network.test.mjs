import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceProviderNetwork, shouldRequestAdditionalEvidence } from './evidence-provider-network.mjs';

test('provider network selects a bounded provider and normalizes provenance-rich evidence', () => {
  const network = new EvidenceProviderNetwork(); network.register({ company_id:'co-58', provider_id:'browser', capability_id:'observe.job', source_kind:'browser', egress_allowed:true, consent:true, estimated_cost:2, confidence:.8 });
  const request = network.request({ company_id:'co-58', request_id:'req-1', capability_id:'observe.job', purpose:'resolve missing job status', consent:true, cost_budget:3 });
  assert.equal(request.state, 'READY'); const result = network.normalizeResult({ company_id:'co-58', request_id:'req-1', evidence_refs:['evidence-1'], acquired_at:'2026-01-01T00:00:00Z', freshness:'fresh', confidence:.9 }); assert.equal(result.authority_effect, false); assert.equal(result.provider_id, 'browser');
});

test('provider network fails closed for consent, cost/egress, cross-company and substitution remains possible', () => {
  const network = new EvidenceProviderNetwork(); network.register({ company_id:'co-58', provider_id:'external-a', capability_id:'observe.job', source_kind:'api', egress_allowed:false, estimated_cost:1, confidence:.9 }); network.register({ company_id:'co-58', provider_id:'external-b', capability_id:'observe.job', source_kind:'api', egress_allowed:true, estimated_cost:5, confidence:.7 });
  assert.equal(network.request({ company_id:'co-58', request_id:'req-2', capability_id:'observe.job', purpose:'investigate', consent:false, cost_budget:10 }).reason, 'consent-required'); assert.equal(network.request({ company_id:'co-58', request_id:'req-3', capability_id:'observe.job', purpose:'investigate', consent:true, cost_budget:2 }).state, 'DEGRADED');
  const ok = network.request({ company_id:'co-58', request_id:'req-4', capability_id:'observe.job', purpose:'investigate', consent:true, cost_budget:6 }); assert.equal(ok.provider_id, 'external-b'); assert.throws(() => network.normalizeResult({ company_id:'co-2', request_id:'req-4', evidence_refs:['x'], acquired_at:'2026-01-01T00:00:00Z' }), /cross-company/);
});

test('additional evidence is requested only below confidence or coverage thresholds', () => { assert.equal(shouldRequestAdditionalEvidence({ confidence:.4, coverage:.9 }).request_required, true); assert.equal(shouldRequestAdditionalEvidence({ confidence:.9, coverage:.9 }).request_required, false); });

