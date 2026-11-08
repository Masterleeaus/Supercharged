import fs from 'node:fs';
import path from 'node:path';

const walk = root => {
  const rows=[];
  const visit = current => {
    for (const entry of fs.readdirSync(current,{withFileTypes:true})) {
      const full=path.join(current,entry.name);
      if(entry.isDirectory()) visit(full);
      else if(entry.isFile()) rows.push({path:path.relative(root,full).replaceAll('\\','/'),bytes:fs.statSync(full).size});
    }
  };
  visit(root);
  return rows;
};

export function summarizeUnpackedPayload(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) throw new Error('payload-root-missing');
  const rows=walk(rootDir);
  const byTopLevel=new Map();
  for(const row of rows){
    const parts=row.path.split('/');
    const key=parts.length>1?parts[0]:'(root files)';
    const cur=byTopLevel.get(key)||{files:0,uncompressed_bytes:0};
    cur.files+=1; cur.uncompressed_bytes+=row.bytes; byTopLevel.set(key,cur);
  }
  return Object.freeze({
    schema:'titan.zero.unpacked-payload-summary.v1',
    file_count:rows.length,
    uncompressed_bytes:rows.reduce((n,row)=>n+row.bytes,0),
    top_level:Object.freeze([...byTopLevel.entries()].map(([name,value])=>Object.freeze({name,...value})).sort((a,b)=>b.uncompressed_bytes-a.uncompressed_bytes)),
    authority_effect:false,
    grants_authority:false,
    identity_not_authority:true,
  });
}

export function comparePayloadBaseline(before, after) {
  const b=Number(before?.uncompressed_bytes||0), a=Number(after?.uncompressed_bytes||0);
  return Object.freeze({before_bytes:b,after_bytes:a,delta_bytes:a-b,delta_ratio:b?((a-b)/b):0,authority_effect:false,grants_authority:false});
}
