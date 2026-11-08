import { buildTitanToolLaunchMap, validateTitanToolLaunchMap } from "./tool-launch-model.mjs";

const clean=v=>String(v??"").trim();
const clone=v=>v==null?v:structuredClone(v);

export function buildToolHostManifest(registry,{host="generic",version="1.0.0"}={}){
 if(!registry||!Array.isArray(registry.tools))throw new Error("tool-registry-required");
 const censusTools=registry.tools.map(tool=>({id:tool.tool_id}));
 const launch=buildTitanToolLaunchMap(censusTools);
 const validation=validateTitanToolLaunchMap(launch,censusTools);
 if(!validation.ok)throw new Error(`tool-host-manifest-launch-invalid:${validation.errors.join("|")}`);
 const capabilities=registry.tools.map(tool=>Object.freeze({
   id:clean(tool.tool_id),
   name:clean(tool.name),
   authority_class:clean(tool.authority_class),
   grants_execution_authority:false,
   company_boundary:"company_id",
   autonomy_ceiling:clean(tool.autonomy_ceiling),
   inputs:clone(tool.inputs??[]),
   outputs:clone(tool.outputs??[]),
   launch:clone(launch[tool.tool_id]),
 })).sort((a,b)=>a.id.localeCompare(b.id));
 return Object.freeze({
   schema:"titan.zero.tools.host-manifest.v1",
   host:clean(host)||"generic",
   version:clean(version)||"1.0.0",
   canonical_owner:"packages/tools",
   generated_projection:true,
   company_boundary:"company_id",
   mutation_authority:"Titan Command Bus",
   capabilities:Object.freeze(capabilities),
 });
}

export function validateToolHostManifest(manifest){
 if(manifest?.schema!=="titan.zero.tools.host-manifest.v1")throw new Error("invalid-tool-host-manifest-schema");
 if(manifest.canonical_owner!=="packages/tools"||manifest.generated_projection!==true)throw new Error("invalid-tool-host-manifest-ownership");
 if(manifest.company_boundary!=="company_id")throw new Error("invalid-tool-host-company-boundary");
 if(manifest.mutation_authority!=="Titan Command Bus")throw new Error("invalid-tool-host-mutation-authority");
 const seen=new Set();
 for(const c of manifest.capabilities??[]){
   if(!c.id||seen.has(c.id))throw new Error("duplicate-or-missing-host-capability");
   seen.add(c.id);
   if(c.company_boundary!=="company_id")throw new Error(`invalid-host-capability-company-boundary:${c.id}`);
   if(c.grants_execution_authority!==false)throw new Error(`host-capability-authority-leak:${c.id}`);
   if(!c.launch?.action||!c.launch?.entrypoint)throw new Error(`host-capability-launch-missing:${c.id}`);
 }
 return true;
}
