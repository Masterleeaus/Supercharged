export function summarizeRegistrySourceVerification(registry){
 const tools=(registry?.tools??[]).map(t=>({
   tool_id:t.tool_id,
   status:t.current_source_verification??((t.dependencies??[]).length?"declared":"required"),
   active_dependencies:Object.freeze([...(t.dependencies??[])]),
   historical_evidence_count:(t.historical_evidence??[]).length,
 }));
 const counts=tools.reduce((a,t)=>(a[t.status]=(a[t.status]??0)+1,a),{});
 return Object.freeze({
   schema:"titan.zero.tools.source-verification.v1",
   canonical_owner:"packages/tools",
   total:tools.length,
   counts:Object.freeze(counts),
   all_current:tools.every(t=>t.status==="verified-current"),
   tools:Object.freeze(tools),
 });
}

export function applyVerifiedSourceMap(registry,verifiedSourceMap={}){
 return {
   ...registry,
   tools:(registry?.tools??[]).map(tool=>{
     const sources=verifiedSourceMap[tool.tool_id];
     if(!Array.isArray(sources)||sources.length===0)return {...tool};
     return {...tool,current_source_verification:"verified-current",current_sources:[...new Set(sources)]};
   }),
 };
}

export function assertCurrentToolSources(registry){
 const report=summarizeRegistrySourceVerification(registry);
 if(!report.all_current){
   const pending=report.tools.filter(t=>t.status!=="verified-current").map(t=>t.tool_id);
   throw new Error(`tool-current-source-verification-pending:${pending.join(",")}`);
 }
 return report;
}
