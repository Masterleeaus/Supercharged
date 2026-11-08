import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TEXT_EXTENSIONS = new Set(['.js','.mjs','.cjs','.html','.json','.md','.css','.txt','.ts','.tsx','.jsx']);

function walk(root) {
  const out=[];
  for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
    const abs=path.join(root,entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function findTextReferences(root, target, {exclude=[]}={}) {
  const refs=[];
  const excluded=new Set(exclude.map(x=>x.replaceAll('\\','/')));
  const targetBase=path.posix.basename(target);
  for (const abs of walk(root)) {
    const rel=path.relative(root,abs).replaceAll('\\','/');
    if (excluded.has(rel) || rel===target) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    let text='';
    try { text=fs.readFileSync(abs,'utf8'); } catch { continue; }
    if (text.includes(target) || text.includes(targetBase)) refs.push(rel);
  }
  return refs.sort();
}

export function auditDuplicateGroup(root, files) {
  const entries=files.map(file=>{
    const abs=path.join(root,file);
    return {file,exists:fs.existsSync(abs),bytes:fs.existsSync(abs)?fs.statSync(abs).size:null,sha256:fs.existsSync(abs)?sha256File(abs):null};
  });
  const present=entries.filter(x=>x.exists);
  return {
    entries,
    exact_duplicate: present.length>1 && new Set(present.map(x=>x.sha256)).size===1,
    authority_effect:false,
    grants_authority:false,
    identity_not_authority:true
  };
}

export function classifyReachability(root, targets) {
  return targets.map(target=>({
    target,
    exists:fs.existsSync(path.join(root,target)),
    references:findTextReferences(root,target),
    reference_count:findTextReferences(root,target).length
  }));
}
