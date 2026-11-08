import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityRequirementResolver } from "./capability-requirement-resolver.mjs";

const registry={company_id:"co-1",entries:[
 {registry_id:"native:query:jobs.view",id:"jobs.view",capabilities:["jobs.view"],permissions:["jobs.read"],mutates:false,risk_class:"LOW",raw:{}},
 {registry_id:"native:action:booking.create",id:"booking.create",capabilities:["booking.create"],permissions:["booking.write"],mutates:true,risk_class:"MEDIUM",autonomy:"auto",execution_contract:{autonomy:"auto",evidence_required:["customer_request"],approval_required_for:["external_commitment"]},raw:{effect:"book",entitlements:["booking"],reversibility:"reversible"}},
]};

test("read capability resolves non-protected read requirement",async()=>{
 const r=await new CapabilityRequirementResolver({registry}).resolve({company_id:"co-1",capability:"jobs.view"});
 assert.equal(r.effect,"read"); assert.equal(r.protected_action,false); assert.equal(r.minimum_autonomy_score,0); assert.deepEqual(r.required_permissions,["jobs.read"]);
});

test("mutating capability preserves evidence approval access and autonomy requirements",async()=>{
 const r=await new CapabilityRequirementResolver({registry}).resolve({company_id:"co-1",capability:"booking.create"});
 assert.equal(r.effect,"book"); assert.equal(r.protected_action,true); assert.equal(r.minimum_autonomy_score,51);
 assert.deepEqual(r.required_permissions,["booking.write"]); assert.deepEqual(r.required_entitlements,["booking"]); assert.deepEqual(r.required_evidence,["customer_request"]); assert.equal(r.approval_policy,"registry_required");
});

test("unknown capability fails closed by returning no requirement",async()=>{
 assert.equal(await new CapabilityRequirementResolver({registry}).resolve({company_id:"co-1",capability:"unknown.execute"}),null);
});

test("company-scoped registry cannot resolve another company",async()=>{
 await assert.rejects(()=>new CapabilityRequirementResolver({registry}).resolve({company_id:"co-2",capability:"jobs.view"}),/company-mismatch/);
});

test("canonical host action resolves through #640 authority without entering the tool list",async()=>{
 const hostAction={
  capability_id:"titan.workforce.reassign",kind:"host_action",operation:"reassign",effect:"write",mutates:true,
  required_permissions:["titan.workforce.reassign"],risk_class:"MEDIUM",default_grants:[],grants_execution_authority:false,
  execution_contract:{autonomy:"auto",evidence_required:["management_authority"],approval_required_for:["work_reassignment"]},
 };
 const current={...registry,action_capabilities:[hostAction]};
 const r=await new CapabilityRequirementResolver({registry:current}).resolve({company_id:"co-1",capability:hostAction.capability_id});
 assert.equal(r.capability,hostAction.capability_id);
 assert.equal(r.operation,"reassign");
 assert.equal(r.effect,"write");
 assert.equal(r.protected_action,true);
 assert.equal(r.minimum_autonomy_score,51);
 assert.deepEqual(r.required_permissions,[hostAction.capability_id]);
 assert.deepEqual(r.required_evidence,["management_authority"]);
 assert.equal(r.approval_policy,"registry_required");
});
