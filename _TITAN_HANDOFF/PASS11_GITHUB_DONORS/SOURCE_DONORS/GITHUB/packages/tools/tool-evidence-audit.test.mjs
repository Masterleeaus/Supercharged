import assert from "node:assert/strict";
import { classifyToolEvidencePath, auditToolEvidence } from "./tool-evidence-audit.mjs";

export function runToolEvidenceAuditTests(){
 const reachable=new Set(["apps/web/current-tool.ts"]);
 assert.equal(classifyToolEvidencePath("apps/web/current-tool.ts",{reachablePaths:reachable}).status,"current");
 assert.equal(classifyToolEvidencePath("titan-zero-chat-content.compat.js").status,"compatibility-or-donor");
 assert.equal(classifyToolEvidencePath("titan-regression/monica-retriever/PASS05.json").status,"compatibility-or-donor");
 assert.equal(classifyToolEvidencePath("static/old.png").status,"legacy-unverified");
 assert.equal(classifyToolEvidencePath("chatTab.html").status,"legacy-unverified");
 assert.equal(classifyToolEvidencePath("unknown/tool.json").status,"unverified");
 assert.equal(classifyToolEvidencePath("").status,"invalid");

 const census={tools:[
   {id:"current",evidence:["apps/web/current-tool.ts"]},
   {id:"donor",evidence:["titan-zero-chat-content.compat.js"]},
   {id:"legacy",externalized_evidence:["static/old.png"]}
 ]};
 const result=auditToolEvidence(census,{reachablePaths:[...reachable]});
 assert.equal(result.ok,false);
 assert.equal(result.unresolved.length,2);
 assert.deepEqual(result.unresolved.map(x=>x.tool_id),["donor","legacy"]);
 assert.equal(result.current_source_required,true);
 return {ok:true,tests:11};
}

if(import.meta.url===`file://${process.argv[1]}`) console.log(JSON.stringify(runToolEvidenceAuditTests()));
