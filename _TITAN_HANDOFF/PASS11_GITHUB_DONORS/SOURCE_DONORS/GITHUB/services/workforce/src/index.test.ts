import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkforceService } from "./index.js";
import { MemoryWorkforceStore } from "./memory-store.js";
import { WorkforceRuntimeAdapter } from "./runtime-adapter.js";

const base = (company_id:string, work_id:string, dependencies:string[]=[]) => ({ company_id, work_id, objective:`work ${work_id}`, creator:"owner", priority:1, dependencies, required_capabilities:[] });

test("work lifecycle is company scoped and dependency aware", async () => {
  const store=new MemoryWorkforceStore(); const service=new WorkforceService(store);
  const first=await service.create(base("c1","w1")); assert.equal(first.state,"READY");
  const second=await service.create(base("c1","w2",["w1"])); assert.equal(second.state,"BLOCKED");
  await assert.rejects(()=>service.start("c2","w1","x"),/work not found/);
  await service.claim("c1","w1","agent-1"); await service.start("c1","w1","agent-1"); await service.complete("c1","w1","agent-1",{ok:true},["e1"]);
  assert.equal((await store.get("c1","w2"))?.state,"READY");
});

test("authority requirement waits for approval and delegation grants no authority", async () => {
  const store=new MemoryWorkforceStore();
  let checks=0;
  const service=new WorkforceService(store,undefined,{async isSatisfied(){checks++;return false;}});
  await service.create({...base("c1","w3"),authority_requirement:"schedule.change"});
  await service.delegate("c1","w3","agent-2","owner");
  assert.equal(checks,0);
  const claimed=await service.claim("c1","w3","agent-2");
  assert.equal(checks,1); assert.equal(claimed.state,"WAITING_APPROVAL");
});

test("circular dependencies are rejected", async () => {
  const store=new MemoryWorkforceStore(); const service=new WorkforceService(store);
  await service.create(base("c1","a"));
  await assert.rejects(()=>service.create(base("c1","b",["missing"])),/dependency not found/);
  await assert.rejects(()=>service.create(base("c1","self",["self"])),/circular dependency/);
});

const repoRoot = resolve(process.cwd(), "../..");
function productionFiles(dir:string):string[]{
  const out:string[]=[];
  for(const entry of readdirSync(dir)){
    const full=join(dir,entry);
    const rel=full.slice(repoRoot.length+1).replaceAll("\\","/");
    if(rel==="packages/workforce"||rel.startsWith("packages/workforce/"))continue;
    if(entry==="node_modules"||entry===".git"||entry.endsWith(".test.ts")||entry.endsWith(".test.mjs"))continue;
    const stat=statSync(full);
    if(stat.isDirectory())out.push(...productionFiles(full));
    else if(/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)||entry==="package.json")out.push(full);
  }
  return out;
}

test("legacy workforce is excluded from workspace and unreachable from production imports",()=>{
  const workspace=readFileSync(join(repoRoot,"pnpm-workspace.yaml"),"utf8");
  assert.match(workspace,/!packages\/workforce/,"packages/workforce must be excluded from the production workspace");
  const forbidden=["@titan-zero/workforce-legacy","packages/workforce/"];
  const offenders:string[]=[];
  for(const root of ["apps","services","packages"])for(const file of productionFiles(join(repoRoot,root))){
    const text=readFileSync(file,"utf8");
    if(forbidden.some(token=>text.includes(token)))offenders.push(file.slice(repoRoot.length+1));
  }
  assert.deepEqual(offenders,[],`legacy workforce remains production-reachable: ${offenders.join(", ")}`);
});

test("recoverable company/work run resumes instead of starting a duplicate runtime",async()=>{
  const calls:string[]=[];
  const adapter=new WorkforceRuntimeAdapter({
    async findRecoverableByWork(input){calls.push(`find:${input.company_id}:${input.work_id}`);return{run_id:"run-1",state:"WAITING_APPROVAL",agent_id:"worker-1"};},
    async resume(input){calls.push(`resume:${input.company_id}:${input.run_id}`);},
    async start(){calls.push("start");},
  });
  await adapter.wake({company_id:"company-a",worker_id:"worker-1",work_id:"work-1"});
  assert.deepEqual(calls,["find:company-a:work-1","resume:company-a:run-1"]);
});

test("new work starts once with origin correlation and no authority semantics",async()=>{
  const starts:unknown[]=[];
  const adapter=new WorkforceRuntimeAdapter({
    async findRecoverableByWork(){return null;},
    async resume(){throw new Error("unexpected resume");},
    async start(input){starts.push(input);},
  });
  await adapter.wake({company_id:"company-a",worker_id:"worker-1",work_id:"work-2",origin:{surface:"zero",actor_id:"one-1",conversation_id:"conv-1",correlation_id:"corr-1"}});
  assert.equal(starts.length,1);
  assert.deepEqual(starts[0],{company_id:"company-a",actor_id:"one-1",agent_id:"worker-1",conversation_id:"conv-1",work_id:"work-2",role:"workforce-worker",messages:[{role:"system",content:"Work item work-2 is ready. Load its governed context and continue it."}]});
  assert.equal(Object.hasOwn(starts[0] as object,"authority"),false);
});

test("recoverable run assigned to another worker fails closed",async()=>{
  const adapter=new WorkforceRuntimeAdapter({
    async findRecoverableByWork(){return{run_id:"run-2",state:"READY",agent_id:"worker-other"};},
    async resume(){throw new Error("must not resume conflicting run");},
    async start(){throw new Error("must not start duplicate run");},
  });
  await assert.rejects(()=>adapter.wake({company_id:"company-a",worker_id:"worker-1",work_id:"work-3"}),/runtime-work-assignee-conflict/);
});
