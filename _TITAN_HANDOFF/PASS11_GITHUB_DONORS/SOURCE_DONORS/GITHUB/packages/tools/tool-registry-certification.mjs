import { buildToolHostManifest, validateToolHostManifest } from "./tool-host-manifest.mjs";
import { classifyToolRegistryChange } from "./registry-change-classifier.mjs";

const forbidden=["tenant_id","tenantId","tenant_company_id"];
export function certifyToolRegistry(registry,{previousRegistry=null,hosts=["generic"]}={}){
 const failures=[];
 if(registry?.canonical_company_boundary!=="company_id")failures.push("registry-company-boundary");
 const ids=new Set();
 for(const tool of registry?.tools??[]){
   if(!tool.tool_id||ids.has(tool.tool_id))failures.push(`duplicate-or-missing-tool:${tool.tool_id??""}`);
   ids.add(tool.tool_id);
   const serialized=JSON.stringify(tool);
   for(const key of forbidden)if(serialized.includes(`"${key}"`))failures.push(`legacy-tenant-field:${tool.tool_id}:${key}`);
   if(tool.grants_execution_authority!==false)failures.push(`authority-leak:${tool.tool_id}`);
 }
 const hostResults=[];
 for(const host of hosts){
   try{
     const manifest=buildToolHostManifest(registry,{host});
     validateToolHostManifest(manifest);
     hostResults.push({host,ok:true,capability_count:manifest.capabilities.length});
   }catch(error){failures.push(`host:${host}:${error.message}`);hostResults.push({host,ok:false});}
 }
 const change=previousRegistry?classifyToolRegistryChange(previousRegistry,registry):null;
 return Object.freeze({
   schema:"titan.zero.tools.registry-certification.v1",
   ok:failures.length===0,
   canonical_owner:"packages/tools",
   company_boundary:"company_id",
   mutation_authority:"Titan Command Bus",
   capability_count:ids.size,
   hosts:Object.freeze(hostResults),
   change,
   failures:Object.freeze([...new Set(failures)]),
 });
}
export function assertCertifiedToolRegistry(registry,options){
 const result=certifyToolRegistry(registry,options);
 if(!result.ok)throw new Error(`tool-registry-certification-failed:${result.failures.join("|")}`);
 return result;
}
