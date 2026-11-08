import assert from "node:assert/strict";
import { classifyToolRegistryChange, assertNoUnversionedBreakingChange } from "./registry-change-classifier.mjs";
import { buildToolHostManifest, validateToolHostManifest } from "./tool-host-manifest.mjs";
import { certifyToolRegistry } from "./tool-registry-certification.mjs";

const tool=(overrides={})=>({
 tool_id:"quote",name:"Quote",authority_class:"prepare",grants_execution_authority:false,
 company_scope:{canonical_key:"company_id",legacy_keys_authoritative:false},
 autonomy_ceiling:"Prepare",supported_roles:["owner"],inputs:["company_context"],outputs:["tool_result"],
 cost_route:["on_device"],offline:{suitable:true,requires_queue_for_effects:false},...overrides
});
const registry=(tools=[tool()])=>({schema:"titan-zero-tool-registry/v1",canonical_company_boundary:"company_id",tools});

export function runToolRegistryCompatibilityTests(){
 const base=registry();
 const added=registry([tool(),tool({tool_id:"schedule",name:"Schedule"})]);
 assert.equal(classifyToolRegistryChange(base,added).semantic_version_impact,"minor");
 const breaking=registry([tool({company_scope:{canonical_key:"account_id",legacy_keys_authoritative:false}})]);
 assert.equal(classifyToolRegistryChange(base,breaking).semantic_version_impact,"major");
 assert.throws(()=>assertNoUnversionedBreakingChange(base,breaking,{declared_impact:"minor"}),/underdeclared/);

 const manifest=buildToolHostManifest(base,{host:"chatgpt"});
 assert.equal(validateToolHostManifest(manifest),true);
 assert.equal(manifest.company_boundary,"company_id");
 assert.equal(manifest.capabilities[0].grants_execution_authority,false);

 const bad=registry([tool({grants_execution_authority:true})]);
 const certification=certifyToolRegistry(bad,{hosts:["chatgpt","browser"]});
 assert.equal(certification.ok,false);
 assert.ok(certification.failures.some(x=>x.includes("authority-leak")));

 return {ok:true,tests:8};
}

if(import.meta.url===`file://${process.argv[1]}`) console.log(JSON.stringify(runToolRegistryCompatibilityTests()));
