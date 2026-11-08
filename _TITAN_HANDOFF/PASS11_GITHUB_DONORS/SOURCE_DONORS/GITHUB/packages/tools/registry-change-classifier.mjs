const LEVEL={none:0,patch:1,minor:2,major:3};
const clean=v=>String(v??'').trim();
const ids=r=>new Map((r?.tools??[]).map(t=>[clean(t.tool_id),t]).filter(([id])=>id));

function stable(v){
 if(v==null||typeof v!=="object")return JSON.stringify(v);
 if(Array.isArray(v))return `[${v.map(stable).join(",")}]`;
 return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
function impact(a,b){
 if(!a||!b)return "major";
 const breaking=["company_scope","inputs","outputs","authority_class","grants_execution_authority","autonomy_ceiling"];
 for(const k of breaking)if(stable(a[k])!==stable(b[k]))return "major";
 const behavioral=["supported_roles","cost_route","offline","launch_surface"];
 for(const k of behavioral)if(stable(a[k])!==stable(b[k]))return "minor";
 return stable(a)===stable(b)?"none":"patch";
}
export function classifyToolRegistryChange(previous,current){
 const before=ids(previous),after=ids(current),changes=[];
 for(const [id,tool] of before)if(!after.has(id))changes.push({tool_id:id,type:"removed",impact:"major"});
 for(const [id,tool] of after){
   if(!before.has(id)){changes.push({tool_id:id,type:"added",impact:"minor"});continue;}
   const i=impact(before.get(id),tool);if(i!=="none")changes.push({tool_id:id,type:"changed",impact:i});
 }
 let semantic_version_impact="none";
 for(const c of changes)if(LEVEL[c.impact]>LEVEL[semantic_version_impact])semantic_version_impact=c.impact;
 return Object.freeze({schema:"titan.zero.tools.registry-change.v1",semantic_version_impact,changes:Object.freeze(changes)});
}
export function assertNoUnversionedBreakingChange(previous,current,{declared_impact="none"}={}){
 const result=classifyToolRegistryChange(previous,current);
 if(LEVEL[result.semantic_version_impact]>LEVEL[declared_impact])throw new Error(`tool-registry-version-impact-underdeclared:${result.semantic_version_impact}`);
 return result;
}
