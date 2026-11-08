import { buildToolHostManifest, validateToolHostManifest } from "./tool-host-manifest.mjs";

const esc=s=>String(s??"").replaceAll("|","\\|").replaceAll("\n"," ");
export function generateToolHostDocumentation(registry,{host="generic",version="1.0.0"}={}){
 const manifest=buildToolHostManifest(registry,{host,version});
 validateToolHostManifest(manifest);
 const lines=[
   "# Titan Zero Tool Host Manifest",
   "",
   `Generated projection for **${esc(manifest.host)}** version **${esc(manifest.version)}**.`,
   "",
   "Canonical owner: `packages/tools`  ",
   "Company boundary: `company_id`  ",
   "Mutation authority: Titan Command Bus  ",
   "Host manifests do not grant execution authority.",
   "",
   "| Capability | Name | Authority class | Autonomy ceiling | Surface | Entrypoint |",
   "| --- | --- | --- | --- | --- | --- |",
 ];
 for(const c of manifest.capabilities){
   lines.push(`| ${esc(c.id)} | ${esc(c.name)} | ${esc(c.authority_class)} | ${esc(c.autonomy_ceiling)} | ${esc(c.launch.surface)} | ${esc(c.launch.entrypoint)} |`);
 }
 lines.push("","_Generated from the canonical registry. Do not hand-edit generated host projections._","");
 return lines.join("\n");
}

export function generateHostProjectionBundle(registry,options={}){
 const manifest=buildToolHostManifest(registry,options);
 validateToolHostManifest(manifest);
 return Object.freeze({
   manifest,
   documentation:generateToolHostDocumentation(registry,options),
   provenance:Object.freeze({
     schema:"titan.zero.tools.generated-projection-provenance.v1",
     canonical_owner:"packages/tools",
     source:"TOOL-REGISTRY.json",
     generated_projection:true,
     independent_business_logic:false,
   }),
 });
}
