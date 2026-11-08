import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteStorage } from "../../../packages/storage/src/index.js";
import { createProductionRuntimeBootstrap } from "./production-runtime-bootstrap.js";

const company_id="company-bootstrap";

function ports(final="handled") {
  return {
    modelRouter:{async next(){return {final};}},
    capabilities:{async resolve(){return null;}},
    authorityGateway:{async authorize(){return {status:"denied",decision_id:"deny-test"};},async execute(){throw new Error("execute-must-not-be-called");}},
    contextProvider:{async load(input:any){return {company_id:input.company_id};}},
  };
}

async function registerManager(bootstrap:any, company = company_id) {
  await bootstrap.workforce.registerWorker({
    company_id: company,
    worker_id:"zero-gm",
    kind:"digital",
    capabilities:["work.delegate"],
    active:true,
  });
}

const persistenceWorkerPath = fileURLToPath(new URL("./production-persistence-process-worker.mjs", import.meta.url));
const workforceServiceRoot = fileURLToPath(new URL("../", import.meta.url));

function startPersistenceWorker(databasePath: string) {
  const child = fork(persistenceWorkerPath, [], {
    cwd: workforceServiceRoot,
    execArgv: ["--import", "tsx"],
    env: { ...process.env, WORKFORCE_PERSISTENCE_TEST_DATABASE: databasePath },
    silent: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`persistence-worker-exit:${code ?? signal}:${stderr}`));
    });
    child.once("error", reject);
  });
  const waitFor = (type: "ready" | "result") => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`persistence-worker-message-timeout:${type}:${stderr}`)), 10_000);
    const onMessage = (message: any) => {
      if (message?.type === "error") finish(new Error(`persistence-worker-error:${message.error}:${message.stack ?? ""}`));
      else if (message?.type === type) finish(undefined, message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`persistence-worker-exit-before-message:${type}:${code ?? signal}:${stderr}`));
    function finish(error?: Error, message?: any) {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(message);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
  return {
    child,
    exited,
    ready: waitFor("ready"),
    dispatch(input: unknown) {
      const result = waitFor("result");
      child.send({ type: "dispatch", input });
      return result;
    },
  };
}

test("production bootstrap composes the canonical Zero dispatcher over SQLite workforce and persistent runtime", async()=>{
  const storage=createSqliteStorage(":memory:");
  const bootstrap=await createProductionRuntimeBootstrap({storage,ports:ports()});
  assert.ok(bootstrap.zeroDispatcher);
  await registerManager(bootstrap);
  const input={company_id,actor_id:"owner-1",conversation_id:"conv-1",interaction_id:"int-1",client_message_id:"msg-1",text:"Handle tomorrow.",correlation_id:"corr-1"};
  const result=await bootstrap.dispatch(input);
  assert.equal(result.accepted,true);
  const workId="zero:conv-1:msg-1";
  const work=await bootstrap.workforceStore.get(company_id,workId);
  assert.equal(work?.origin?.actor_id,"owner-1");
  assert.equal(work?.origin?.conversation_id,"conv-1");
  assert.equal(work?.origin?.correlation_id,"corr-1");
  assert.equal(work?.assignee,"zero-gm");
  const rows=await storage.query<{payload:string}>(`SELECT payload FROM agent_runs WHERE company_id=$1 AND work_id=$2`,[company_id,workId]);
  assert.equal(rows.rowCount,1);
  const persisted=JSON.parse(rows.rows[0]!.payload);
  assert.equal(persisted.actor_id,"owner-1");
  assert.equal(persisted.conversation_id,"conv-1");
  await storage.close();
});

test("production bootstrap uses canonical company + conversation + client-message idempotency", async()=>{
  const storage=createSqliteStorage(":memory:");
  const bootstrap=await createProductionRuntimeBootstrap({storage,ports:ports()});
  await registerManager(bootstrap);
  const input={company_id,actor_id:"owner-1",conversation_id:"conv-1",interaction_id:"int-duplicate",client_message_id:"msg-dup",text:"What needs attention?",correlation_id:"corr-dup"};
  await bootstrap.dispatch(input);
  await bootstrap.dispatch(input);
  const workId="zero:conv-1:msg-dup";
  const work=await storage.query(`SELECT work_id FROM workforce_work_items WHERE company_id=$1 AND work_id=$2`,[company_id,workId]);
  const runs=await storage.query(`SELECT run_id FROM agent_runs WHERE company_id=$1 AND work_id=$2`,[company_id,workId]);
  assert.equal(work.rowCount,1);
  assert.equal(runs.rowCount,1);
  await storage.close();
});

test("production bootstrap refuses incomplete provider ports", async()=>{
  const storage=createSqliteStorage(":memory:");
  await assert.rejects(()=>createProductionRuntimeBootstrap({storage,ports:{modelRouter:ports().modelRouter} as any}),/production-runtime-port-required/);
  await storage.close();
});

test("completed replay retains the durable run identity after bootstrap restart", async () => {
  const storage = createSqliteStorage(":memory:");
  try {
    const first = await createProductionRuntimeBootstrap({ storage, ports: ports() });
    await registerManager(first);
    const input = { company_id, actor_id: "owner-1", conversation_id: "replay", interaction_id: "int", client_message_id: "msg", text: "Inspect", correlation_id: "corr" };
    const initial = await first.dispatch(input);
    const runId = initial.events.find((e: any) => e.kind === "run.started")?.run_id;
    assert.ok(runId);
    const restarted = await createProductionRuntimeBootstrap({ storage, ports: ports() });
    const replay = await restarted.dispatch(input);
    assert.equal(replay.events.find((e: any) => e.kind === "work.state")?.run_id, runId);
  } finally { await storage.close(); }
});

test("production continuation resumes once with the authenticated user's input", async () => {
  const storage = createSqliteStorage(":memory:");
  try {
    const seen: any[] = [];
    const configured = ports();
    configured.modelRouter = { async next(input: any) {
      seen.push(structuredClone(input));
      return seen.length === 1 ? { wait: { state: "WAITING_USER" } } : { final: "handled" };
    } } as any;
    const bootstrap = await createProductionRuntimeBootstrap({ storage, ports: configured });
    await registerManager(bootstrap);
    const input = { company_id, actor_id: "owner-1", conversation_id: "resume", interaction_id: "int", client_message_id: "msg", text: "Inspect", correlation_id: "corr" };
    const waiting = await bootstrap.dispatch(input);
    assert.ok(waiting.continuation_token);
    await assert.rejects(() => bootstrap.dispatch({ ...input, company_id: "company-b", continuation_token: waiting.continuation_token }), /work-not-found/);
    const done = await bootstrap.dispatch({ ...input, client_message_id: "reply", text: "Continue with this answer", continuation_token: waiting.continuation_token });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].messages.at(-1).content, "Continue with this answer");
    assert.equal(done.events.at(-1)?.state, "COMPLETED");
    const runs = await storage.query("SELECT run_id FROM agent_runs WHERE company_id=$1", [company_id]);
    assert.equal(runs.rowCount, 1);
  } finally { await storage.close(); }
});

test("concurrent Zero delivery creates only one WorkItem and persistent run", async () => {
 const storage=createSqliteStorage(':memory:');
 try {
  const bootstrap=await createProductionRuntimeBootstrap({storage,ports:ports()});await registerManager(bootstrap);
  const input={company_id,actor_id:'owner',conversation_id:'parallel',interaction_id:'int',client_message_id:'message',correlation_id:'corr',text:'Inspect'};
  await Promise.all([bootstrap.dispatch(input),bootstrap.dispatch(input)]);
  assert.equal((await storage.query('SELECT run_id FROM agent_runs WHERE company_id=$1 AND work_id=$2',[company_id,'zero:parallel:message'])).rowCount,1);
 }finally{await storage.close();}
});

test("separate Workforce processes deduplicate an uncertain effect and preserve replay state after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workforce-process-persistence-"));
  const databasePath = join(directory, "runtime.sqlite");
  let storage: ReturnType<typeof createSqliteStorage> | undefined = createSqliteStorage(databasePath);
  const workers: ReturnType<typeof startPersistenceWorker>[] = [];
  try {
    const bootstrap = await createProductionRuntimeBootstrap({ storage, ports: ports() });
    await registerManager(bootstrap, "company-process");
    await storage.query(`CREATE TABLE workforce_test_model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, run_id TEXT NOT NULL
    )`);
    await storage.query(`CREATE TABLE workforce_test_effect_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, run_id TEXT NOT NULL,
      work_id TEXT NOT NULL, correlation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL
    )`);
    await storage.close();
    storage = undefined;

    const input = {
      company_id: "company-process", actor_id: "owner-process", conversation_id: "process-race",
      interaction_id: "interaction-once", client_message_id: "message-once", text: "Inspect once",
      correlation_id: "correlation-process", request_id: "request-process", operation_id: "operation-process",
      trace_id: "trace-process", idempotency_key: "idempotency-process",
    };
    const first = startPersistenceWorker(databasePath);
    const second = startPersistenceWorker(databasePath);
    workers.push(first, second);
    await Promise.all([first.ready, second.ready]);
    const [firstResult, secondResult] = await Promise.all([first.dispatch(input), second.dispatch(input)]);
    await Promise.all([first.exited, second.exited]);
    assert.equal(firstResult.accepted, true);
    assert.equal(secondResult.accepted, true);
    assert.equal(firstResult.run_id, secondResult.run_id);
    // A losing process may observe the deterministic run before its creator
    // has finished advancing it. The post-exit replay below asserts final state.
    const inFlightStates = ["QUEUED", "RUNNING", "WAITING_TOOL", "WAITING_EXTERNAL"];
    assert.ok(inFlightStates.includes(firstResult.run_state), `unexpected first process run state: ${String(firstResult.run_state)}`);
    assert.ok(inFlightStates.includes(secondResult.run_state), `unexpected second process run state: ${String(secondResult.run_state)}`);

    const restarted = startPersistenceWorker(databasePath);
    workers.push(restarted);
    await restarted.ready;
    const replay = await restarted.dispatch(input);
    await restarted.exited;
    assert.equal(replay.accepted, true);
    assert.equal(replay.run_id, firstResult.run_id);
    assert.equal(replay.run_state, "WAITING_EXTERNAL");

    storage = createSqliteStorage(databasePath);
    const workRows = await storage.query<{ company_id: string; work_id: string; state: string; payload: string }>(
      "SELECT company_id,work_id,state,payload FROM workforce_work_items WHERE company_id=$1", [input.company_id]);
    const runRows = await storage.query<{ company_id: string; run_id: string; state: string; payload: string }>(
      "SELECT company_id,run_id,state,payload FROM agent_runs WHERE company_id=$1", [input.company_id]);
    const modelCalls = await storage.query("SELECT id FROM workforce_test_model_calls WHERE company_id=$1", [input.company_id]);
    const effects = await storage.query<{ company_id: string; run_id: string; work_id: string; correlation_id: string; idempotency_key: string }>(
      "SELECT company_id,run_id,work_id,correlation_id,idempotency_key FROM workforce_test_effect_attempts WHERE company_id=$1", [input.company_id]);
    assert.equal(workRows.rowCount, 1);
    assert.equal(workRows.rows[0]!.company_id, input.company_id);
    assert.equal(workRows.rows[0]!.work_id, "zero:process-race:message-once");
    assert.equal(workRows.rows[0]!.state, "WAITING_EXTERNAL");
    assert.equal(runRows.rowCount, 1);
    assert.equal(runRows.rows[0]!.company_id, input.company_id);
    assert.equal(runRows.rows[0]!.run_id, firstResult.run_id);
    assert.equal(runRows.rows[0]!.state, "WAITING_EXTERNAL");
    const run = JSON.parse(runRows.rows[0]!.payload);
    assert.equal(run.wait.execution.state, "UNCERTAIN");
    assert.equal(run.correlation_id, input.correlation_id);
    assert.equal(run.request_id, input.request_id);
    assert.equal(run.operation_id, input.operation_id);
    assert.equal(run.trace_id, input.trace_id);
    assert.equal(run.idempotency_key, input.idempotency_key);
    assert.equal(modelCalls.rowCount, 1);
    assert.equal(effects.rowCount, 1);
    assert.deepEqual(effects.rows[0], {
      company_id: input.company_id,
      run_id: firstResult.run_id,
      work_id: "zero:process-race:message-once",
      correlation_id: input.correlation_id,
      idempotency_key: "tool-effect-once",
    });
    const origin = JSON.parse(workRows.rows[0]!.payload).origin;
    assert.match(origin.dispatch_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(origin, {
      actor_id: input.actor_id,
      conversation_id: input.conversation_id,
      surface: "zero",
      correlation_id: input.correlation_id,
      request_id: input.request_id,
      operation_id: input.operation_id,
      trace_id: input.trace_id,
      idempotency_key: input.idempotency_key,
      dispatch_fingerprint: origin.dispatch_fingerprint,
    });
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    }
    await Promise.allSettled(workers.map(worker => worker.exited));
    await storage?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("production bootstrap composes canonical authority gateway and refuses incomplete resolver ports", async()=>{
  const storage=createSqliteStorage(":memory:");
  const base=ports();
  await assert.rejects(
    ()=>createProductionRuntimeBootstrap({storage,ports:{modelRouter:base.modelRouter,capabilities:base.capabilities,contextProvider:base.contextProvider,executionGateway:{async execute(){return {state:"VERIFIED",verified:true};}}} as any}),
    /production-runtime-port-required:governanceResolver.resolve/,
  );
  await storage.close();
});
