import assert from 'node:assert/strict';
import { createWorkerIdentity, createAuthorityRequirement, createApprovalState } from '../index.mjs';

const worker = createWorkerIdentity({ company_id: 'co-1', worker_id: 'w-1' });
assert.equal(worker.company_id, 'co-1');
assert.equal(worker.identity_confers_authority, false);

const req = createAuthorityRequirement({
  company_id: 'co-1',
  capability: 'booking.create',
  effect: 'book',
  required_permissions: ['booking.write'],
  required_entitlements: ['booking'],
});
assert.equal(req.protected_action, true);

const approval = createApprovalState({ company_id: 'co-1', status: 'approved', approval_id: 'ap-1' });
assert.equal(approval.approval_confers_only_scoped_authority, true);

assert.throws(
  () => createWorkerIdentity({ tenant_id: 'co-1', worker_id: 'w-1' }),
  /legacy-company-boundary/
);

console.log('worker authority portability PASS');
