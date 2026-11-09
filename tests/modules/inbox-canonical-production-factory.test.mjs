import test from 'node:test';import assert from 'node:assert/strict';
import {createCanonicalInboxApprovalService} from '../../server/modules/inbox/canonical-production-approval.ts';
test('real canonical ApprovalService factory rejects invalid database pools before imports',async()=>{
 await assert.rejects(createCanonicalInboxApprovalService(null),/PostgreSQL pool/);
 await assert.rejects(createCanonicalInboxApprovalService({}),/PostgreSQL pool/);
});
