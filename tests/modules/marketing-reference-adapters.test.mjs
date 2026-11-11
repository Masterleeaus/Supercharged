import test from 'node:test';
import assert from 'node:assert/strict';
import {chatbotReferences,unavailableCampaignReferences} from '../../server/modules/marketing/reference-adapters.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
test('chatbot reference lookup uses verified tenant and canonical storage',async()=>{
 const calls=[],refs=chatbotReferences({findChatbot:async(company,id)=>{calls.push([company,id]);return company===A?{id}:null;}});
 assert.equal(await refs.chatbotExists(A,'chatbot-1'),true);
 assert.equal(await refs.chatbotExists(B,'chatbot-1'),false);
 assert.deepEqual(calls,[[A,'chatbot-1'],[B,'chatbot-1']]);
});
test('chatbot refs never query with blank IDs or malformed companies',async()=>{
 const refs=chatbotReferences({findChatbot:async()=>{throw Error('unexpected DB call')}});
 assert.equal(await refs.chatbotExists(A,''),false);
 await assert.rejects(refs.chatbotExists('not-a-uuid','x'),/companyId/);
});
test('unpromoted campaigns cannot accidentally reference legacy voice-call campaigns',async()=>{
 const refs=unavailableCampaignReferences();
 assert.equal(await refs.campaignExists(A,'legacy-voice-id'),false);
 await assert.rejects(refs.campaignExists('invalid','x'),/companyId/);
});
test('missing canonical chatbot lookup is rejected at construction',()=>assert.throws(()=>chatbotReferences({}),/canonical chatbot/));
