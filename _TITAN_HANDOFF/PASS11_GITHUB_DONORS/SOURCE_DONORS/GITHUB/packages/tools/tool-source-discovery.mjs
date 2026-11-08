const normalize=v=>String(v??"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");

export function discoverCurrentToolSources(registry,sourceIndex=[]){
 const files=[...new Set(sourceIndex.map(String))];
 const mappings={};
 const unresolved=[];
 for(const tool of registry?.tools??[]){
   const id=normalize(tool.tool_id);
   const name=normalize(tool.name);
   const tokens=[id,name,...id.split("_").filter(x=>x.length>3)];
   const matches=files.filter(path=>{
     const p=normalize(path);
     return tokens.some(token=>token.length>3&&p.includes(token));
   });
   if(matches.length)mappings[tool.tool_id]=matches;
   else unresolved.push(tool.tool_id);
 }
 return Object.freeze({
   schema:"titan.zero.tools.source-discovery.v1",
   rule:"candidate path matches require review before verified-current",
   mappings:Object.freeze(mappings),
   unresolved:Object.freeze(unresolved),
 });
}

export function approveCurrentToolSources(discovery,approvedToolIds=[]){
 const approved=new Set(approvedToolIds);
 return Object.fromEntries(Object.entries(discovery?.mappings??{}).filter(([id])=>approved.has(id)));
}
