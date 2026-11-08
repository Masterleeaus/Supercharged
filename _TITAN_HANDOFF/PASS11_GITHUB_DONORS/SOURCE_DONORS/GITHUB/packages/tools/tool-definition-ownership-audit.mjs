const norm=v=>String(v??"").trim().toLowerCase();
const SIGNATURE_KEYS=["tool_id","capability_id","authority_class","grants_execution_authority","company_scope","launch_contract"];

function walk(value,path="root",out=[]){
 if(!value||typeof value!=="object")return out;
 if(Array.isArray(value)){value.forEach((v,i)=>walk(v,`${path}[${i}]`,out));return out;}
 const keys=Object.keys(value);
 const signature=keys.filter(k=>SIGNATURE_KEYS.includes(k));
 if(signature.length>=2)out.push({path,keys:signature,definition:value});
 for(const [k,v] of Object.entries(value))walk(v,`${path}.${k}`,out);
 return out;
}

export function auditIndependentToolDefinitions({registry,projections=[]}={}){
 const canonical=new Set((registry?.tools??[]).map(t=>norm(t.tool_id)).filter(Boolean));
 const findings=[];
 for(const projection of projections){
   const owner=projection?.owner||projection?.path||"unknown";
   for(const candidate of walk(projection?.content??projection,owner)){
     const id=norm(candidate.definition.tool_id||candidate.definition.capability_id);
     if(!id)continue;
     const generated=projection?.generated_projection===true||projection?.provenance?.generated_projection===true;
     if(!generated)findings.push({type:"independent-definition",owner,path:candidate.path,id,canonical:canonical.has(id)});
   }
 }
 return Object.freeze({
   schema:"titan.zero.tools.definition-ownership-audit.v1",
   canonical_owner:"packages/tools",
   independent_business_logic_allowed:false,
   ok:findings.length===0,
   findings:Object.freeze(findings),
 });
}

export function assertNoIndependentToolDefinitions(input){
 const result=auditIndependentToolDefinitions(input);
 if(!result.ok)throw new Error(`independent-tool-definitions:${result.findings.map(f=>`${f.owner}:${f.id}`).join(",")}`);
 return result;
}
