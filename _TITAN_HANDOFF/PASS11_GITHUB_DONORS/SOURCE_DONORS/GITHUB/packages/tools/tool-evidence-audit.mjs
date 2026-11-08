const DONOR_MARKERS=["monica","donors/","compat.js"];
const LEGACY_ROOTS=["static/","chatTab.html","content.css","side-panel/","titan-regression/","titan-capabilities/"];

export function classifyToolEvidencePath(path,{reachablePaths=new Set()}={}){
 const p=String(path??"").trim();
 if(!p)return {path:p,status:"invalid"};
 if(reachablePaths.has(p))return {path:p,status:"current"};
 const lower=p.toLowerCase();
 if(DONOR_MARKERS.some(x=>lower.includes(x)))return {path:p,status:"compatibility-or-donor",current_reachability_proven:false};
 if(LEGACY_ROOTS.some(x=>p.startsWith(x)))return {path:p,status:"legacy-unverified",current_reachability_proven:false};
 return {path:p,status:"unverified",current_reachability_proven:false};
}

export function auditToolEvidence(census,{reachablePaths=[]}={}){
 const reachable=new Set(reachablePaths);
 const tools=(census?.tools??[]).map(tool=>{
   const evidence=[...(tool.evidence??[]),...(tool.externalized_evidence??[])];
   const classified=evidence.map(path=>classifyToolEvidencePath(path,{reachablePaths:reachable}));
   return {tool_id:tool.id,statuses:classified};
 });
 const unresolved=tools.flatMap(t=>t.statuses.filter(x=>x.status!=="current").map(x=>({tool_id:t.tool_id,...x})));
 return Object.freeze({
   schema:"titan.zero.tools.evidence-audit.v1",
   rule:"historical evidence strings do not prove current reachability",
   current_source_required:true,
   ok:unresolved.length===0,
   tools:Object.freeze(tools),
   unresolved:Object.freeze(unresolved),
 });
}
