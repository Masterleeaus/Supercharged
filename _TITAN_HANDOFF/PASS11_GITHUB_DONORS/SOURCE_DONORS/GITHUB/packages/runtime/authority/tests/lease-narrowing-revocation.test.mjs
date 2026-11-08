import assert from 'node:assert/strict';
import { evaluateAuthorityDecisionLease, applyAuthorityLeaseControl } from '../index.mjs';

const snapshot={
  company_id:'co-1', decision_id:'lease-parent-1', capability:'booking.create', workflow:'booking', context_ref:'customer:42',
  effective_score:80, status:'verified', source:'titan-autonomy', verified_at:'2026-09-05T02:30:00Z', expires_at:'2026-09-05T05:00:00Z',
};
const now='2026-09-05T03:00:00Z';
const base=evaluateAuthorityDecisionLease({company_id:'co-1',snapshot,now});
assert.equal(base.authority_ceiling,80);

const narrowed=applyAuthorityLeaseControl(base,{company_id:'co-1',status:'active',max_authority_score:25,expires_at:'2026-09-05T04:00:00Z',control_id:'ctl-1'},now);
assert.equal(narrowed.execution_eligible,true);
assert.equal(narrowed.authority_ceiling,25);
assert.equal(narrowed.lease_expires_at,'2026-09-05T04:00:00Z');
assert.ok(narrowed.reason_codes.includes('authority_lease_control_narrowed'));
assert.equal(narrowed.lease_control.identity_confers_authority,false);
assert.equal(narrowed.lease_control.control_can_raise_authority,false);

const revoked=evaluateAuthorityDecisionLease({company_id:'co-1',snapshot,now,lease_control:{company_id:'co-1',status:'revoked',max_authority_score:0,revoked_at:'2026-09-05T02:59:00Z',reason:'manual-revoke'}});
assert.equal(revoked.state,'revoked'); assert.equal(revoked.execution_eligible,false); assert.equal(revoked.authority_ceiling,0);
assert.ok(revoked.reason_codes.includes('authority_lease_control_revoked'));

assert.throws(()=>applyAuthorityLeaseControl(base,{company_id:'co-1',status:'active',max_authority_score:81},now),/authority-increase-forbidden/);
assert.throws(()=>applyAuthorityLeaseControl(base,{company_id:'co-1',status:'active',max_authority_score:20,expires_at:'2026-09-05T06:00:00Z'},now),/expiry-extension-forbidden/);
assert.throws(()=>applyAuthorityLeaseControl(base,{company_id:'co-2',status:'active',max_authority_score:20},now),/company-mismatch/);
assert.throws(()=>applyAuthorityLeaseControl(base,{company_id:'co-1',status:'active',max_authority_score:20,capability:'invoice.pay'},now),/scope-widening:capability/);
assert.throws(()=>applyAuthorityLeaseControl(base,{company_id:'co-1',tenant_id:'co-1',status:'active',max_authority_score:20},now),/legacy-company-boundary/);
assert.throws(()=>applyAuthorityLeaseControl(base,{company_id:'co-1',status:'revoked',max_authority_score:0},now),/revoked-at-required/);

console.log('authority lease narrowing/revocation PASS');
