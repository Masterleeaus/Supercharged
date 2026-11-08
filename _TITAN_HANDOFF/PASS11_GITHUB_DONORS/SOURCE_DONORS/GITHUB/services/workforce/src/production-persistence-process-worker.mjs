import { createSqliteStorage } from "../../../packages/storage/src/index.js";
import { createProductionRuntimeBootstrap } from "./production-runtime-bootstrap.js";

const databasePath = process.env.WORKFORCE_PERSISTENCE_TEST_DATABASE;
if (!databasePath) throw new Error("workforce-persistence-test-database-required");

const storage = createSqliteStorage(databasePath);
try {
  const bootstrap = await createProductionRuntimeBootstrap({
    storage,
    ports: {
      modelRouter: {
        async next({ identity }) {
          await storage.query(
            "INSERT INTO workforce_test_model_calls(company_id,run_id) VALUES($1,$2)",
            [identity.company_id, identity.run_id],
          );
          return { tool_calls: [{ id: "tool-effect-once", name: "test.uncertain-effect", arguments: {} }] };
        },
      },
      capabilities: { async resolve({ name }) { return { name }; } },
      authorityGateway: {
        async authorize() { return { status: "allowed", decision_id: "disposable-test-decision" }; },
        async execute({ company_id, run_id, work_id, idempotency_key }) {
          const persisted = await storage.query(
            "SELECT payload FROM agent_runs WHERE company_id=$1 AND run_id=$2",
            [company_id, run_id],
          );
          if (persisted.rowCount !== 1) throw new Error("runtime-run-persistence-missing");
          const correlation_id = JSON.parse(persisted.rows[0].payload).correlation_id;
          if (typeof correlation_id !== "string") throw new Error("runtime-run-correlation-missing");
          await storage.query(
            `INSERT INTO workforce_test_effect_attempts(company_id,run_id,work_id,correlation_id,idempotency_key)
             VALUES($1,$2,$3,$4,$5)`,
            [company_id, run_id, work_id, correlation_id, idempotency_key],
          );
          return { state: "UNCERTAIN", operation_id: "disposable-test-operation" };
        },
      },
      contextProvider: { async load({ company_id }) { return { company_id }; } },
    },
  });
  process.send?.({ type: "ready" });
  process.on("message", async message => {
    if (message?.type !== "dispatch") return;
    try {
      const result = await bootstrap.dispatch(message.input);
      const workId = `zero:${message.input.conversation_id}:${message.input.client_message_id}`;
      const run = await bootstrap.runStore.findByWork(message.input.company_id, workId);
      process.send?.({ type: "result", accepted: result.accepted, run_id: run?.run_id, run_state: run?.state });
      await storage.close();
      process.disconnect?.();
    } catch (error) {
      process.send?.({ type: "error", error: String(error?.message ?? error), stack: String(error?.stack ?? "") });
      await storage.close();
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
} catch (error) {
  await storage.close().catch(() => undefined);
  process.send?.({ type: "error", error: String(error?.message ?? error), stack: String(error?.stack ?? "") });
  process.exitCode = 1;
  process.disconnect?.();
}
