import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityContextResolver } from "./authority-context-resolver.mjs";

const company_id="co-1", worker_id="worker-1", capability="booking.create";
const snapshot={company_id,decision_id:"snap-1",capability,effective_score:65,status:"verified",source:"titan-autonomy",verified_at:"2026-09-28T00:00:00Z",expires_at:"2026-09-29T00:00:00Z",trusted_auto_handshake:{platform:true,user:true,assurance:true},predictive_ready:false};
const approval={company_id,approval_id:"ap-1",approval_scope:"act-1",status:"approved",approver_id:"human-1",granted_at:"2026-09-28T00:05:00Z"};
const store={async latestAutonomySnapshot(){return snapshot;},async latestApproval(){return approval;}};
const input={company_id,actor_id:"manager-1",agent_id:worker_id,worker_type:"human",surface:"directadmin",capability,operation_id:"op-1",action_id:"act-1",now:"2026-09-28T00:10:00Z"};
const requirement={company_id,capability,operation:"create",effect:"book",required_permissions:["booking.write"],required_entitlements:["booking"],required_evidence:["customer_request"],minimum_autonomy_score:51,approval_policy:"protected_action"};
const good={
 requirementResolver:{async resolve(){return requirement;}},
 accessResolver:{async resolve(){return {permissions:["booking.write"],entitlements:["booking"]};}},
 governanceResolver:{async resolve(){return {policy_allows:true,governance_allows:true,assurance_allows:true};}},
 evidenceResolver:{async resolve(){return {status:"satisfied",refs:["ev-1"]};}},
 riskResolver:{async resolve(){return {level:"medium"};}},
 connectivityResolver:{async resolve(){return {state:"online"};}},
};

test("resolver returns ALLOW only with complete canonical context",async()=>{
 const resolver=new AuthorityContextResolver({authorityStore:store,...good});
 const decision=await resolver.evaluate(input);
 assert.equal(decision.decision,"ALLOW");
 assert.equal(decision.identity_confers_authority,false);
 assert.equal(decision.actor_id,"manager-1");
 assert.equal(decision.worker_type,"human");
 assert.equal(decision.surface,"directadmin");
});

test("missing autonomy fails closed",async()=>{
 const resolver=new AuthorityContextResolver({authorityStore:{...store,async latestAutonomySnapshot(){return null;}},...good});
 assert.equal((await resolver.evaluate(input)).decision,"AUTHORITY_UNAVAILABLE");
});

test("missing access cannot grant authority",async()=>{
 const {accessResolver,...rest}=good;
 const resolver=new AuthorityContextResolver({authorityStore:store,...rest});
 assert.equal((await resolver.evaluate(input)).decision,"DENY");
});

test("missing governance cannot grant authority",async()=>{
 const {governanceResolver,...rest}=good;
 const resolver=new AuthorityContextResolver({authorityStore:store,...rest});
 assert.equal((await resolver.evaluate(input)).decision,"DENY");
});

test("missing risk defaults to critical and denies",async()=>{
 const {riskResolver,...rest}=good;
 const resolver=new AuthorityContextResolver({authorityStore:store,...rest});
 assert.equal((await resolver.evaluate(input)).decision,"DENY");
});

test("missing evidence cannot satisfy required evidence",async()=>{
 const {evidenceResolver,...rest}=good;
 const resolver=new AuthorityContextResolver({authorityStore:store,...rest});
 assert.equal((await resolver.evaluate(input)).decision,"EVIDENCE_REQUIRED");
});
