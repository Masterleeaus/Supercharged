import test from 'node:test';
import assert from 'node:assert/strict';
import {unavailableCampaignReferences} from '../../server/modules/marketing/reference-adapters.ts';
const A='11111111-1111-4111-8111-111111111111';
test('all unresolved campaign IDs fail closed instead of querying conflicting legacy campaigns',async()=>{
 const refs=unavailableCampaignReferences();
 for(const id of ['active-voice-campaign','random','a'.repeat(20)])assert.equal(await refs.campaignExists(A,id),false);
});
