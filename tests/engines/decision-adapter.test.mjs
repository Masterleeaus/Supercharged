// Tests for the Desk decision adapter (server/engines/decision/index.ts).
// Run from the repository root:
//   node --experimental-transform-types --test tests/engines/decision-adapter.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

// The engine's runtime imports siblings with ".js" specifiers that point at ".ts" files.
// Plain Node does not map them, so this hook does (the same mapping the source repo uses).
const resolveHook = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolveHook));

const {
  bindDecisionEngine,
  validateCompanyId,
  REFUSING_PERSISTENCE,
} = await import("../../server/engines/decision/index.ts");

const STAGES = [
  "observation",
  "evidence",
  "entity_normalization",
  "context_enrichment",
  "option_discovery",
  "objectives",
  "constraints",
  "preferences",
  "comparison",
  "prediction",
  "ranking",
  "best_action",
  "explanation",
  "confidence",
];

function stageAdapters(calls) {
  const stages = {};
  for (const stage of STAGES) {
    stages[stage] = (context) => {
      calls.push({ stage, company_id: context.company_id });
      if (stage === "constraints") {
        return {
          company_id: context.company_id,
          workflow_gate: { state: "ready", eligible_option_ids: ["option-1"] },
        };
      }
      if (stage === "best_action") {
        return { company_id: context.company_id, status: "recommend" };
      }
      return { company_id: context.company_id, stage };
    };
  }
  return stages;
}

function memoryPersistence() {
  const rows = [];
  const calls = { load: [], append: [] };
  return {
    rows,
    calls,
    async loadLatestHistory(companyId, decisionId) {
      calls.load.push([companyId, decisionId]);
      const matches = rows.filter((row) => row.company_id === companyId && row.decision_id === decisionId);
      return matches.at(-1) ?? null;
    },
    async appendHistory(companyId, entry) {
      calls.append.push([companyId, entry.company_id]);
      rows.push(entry);
    },
  };
}

function validRequest(overrides = {}) {
  return {
    decision_subject_id: "subject-1",
    decision_id: "decision-1",
    run_id: "run-1",
    idempotency_key: "idem-1",
    trigger: "manual",
    requested_at: "2026-11-02T00:00:00.000Z",
    input: { note: "synthetic" },
    ...overrides,
  };
}

function assertRejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("missing company_id is refused", () => {
  const persistence = memoryPersistence();
  const calls = [];
  for (const value of [undefined, null, "", "   ", 42, {}]) {
    assert.throws(
      () => bindDecisionEngine(value, { persistence, stages: stageAdapters(calls) }),
      (error) => error.code === "company_id_required",
    );
  }
  assert.throws(
    () => bindDecisionEngine("company with spaces", { persistence, stages: stageAdapters(calls) }),
    (error) => error.code === "company_id_invalid",
  );
  assert.equal(calls.length, 0);
});

test("valid company ids are accepted, including UUIDs", () => {
  assert.equal(validateCompanyId("company-1"), "company-1");
  assert.equal(validateCompanyId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
});

test("company fields in a decision request are refused and never used", async () => {
  const persistence = memoryPersistence();
  const calls = [];
  const decide = bindDecisionEngine("company-a", { persistence, stages: stageAdapters(calls) });

  await assertRejectsWithCode(decide(validRequest({ company_id: "company-b" })), "company_scope_not_accepted");
  await assertRejectsWithCode(decide(validRequest({ tenant_id: "company-b" })), "company_scope_not_accepted");
  await assertRejectsWithCode(decide(validRequest({ tenant_company_id: "company-b" })), "company_scope_not_accepted");
  assert.equal(calls.length, 0, "no stage runs when a company field is present");
  assert.equal(persistence.calls.load.length, 0);
  assert.equal(persistence.calls.append.length, 0);
});

test("unknown inputs fail closed before any stage runs", async () => {
  const persistence = memoryPersistence();
  const calls = [];
  const decide = bindDecisionEngine("company-a", { persistence, stages: stageAdapters(calls) });

  const cases = [
    [validRequest({ surprise: true }), "unknown_request_field"],
    [validRequest({ trigger: "cron" }), "invalid_trigger"],
    [validRequest({ requested_at: "not a date" }), "invalid_requested_at"],
    [validRequest({ input: [] }), "invalid_request"],
    [validRequest({ input: null }), "invalid_request"],
    [validRequest({ decision_id: "" }), "invalid_request"],
    [validRequest({ source_event_id: 7 }), "invalid_request"],
    [null, "invalid_request"],
    [[], "invalid_request"],
    ["decide everything", "invalid_request"],
  ];
  for (const [request, code] of cases) {
    await assertRejectsWithCode(decide(request), code);
  }
  assert.equal(calls.length, 0);
  assert.equal(persistence.calls.append.length, 0);
});

test("default with no persistence refuses to decide", async () => {
  const calls = [];
  const stages = stageAdapters(calls);

  const withoutPersistence = bindDecisionEngine("company-a", { stages });
  await assertRejectsWithCode(withoutPersistence(validRequest()), "persistence_not_injected");

  const withDefault = bindDecisionEngine("company-a", { persistence: REFUSING_PERSISTENCE, stages });
  await assertRejectsWithCode(withDefault(validRequest()), "persistence_not_injected");

  const partial = bindDecisionEngine("company-a", {
    persistence: { loadLatestHistory: async () => null },
    stages,
  });
  await assertRejectsWithCode(partial(validRequest()), "persistence_not_injected");

  assert.equal(calls.length, 0, "refusal happens before the first stage");
});

test("bound decision records hash-linked history for its company only", async () => {
  const persistence = memoryPersistence();
  const calls = [];
  const decideA = bindDecisionEngine("company-a", { persistence, stages: stageAdapters(calls) });

  const first = await decideA(validRequest());
  assert.equal(first.status, "completed");
  assert.equal(first.authority_effect, "none");
  assert.equal(first.artifacts.history.company_id, "company-a");
  assert.equal(first.artifacts.history.revision, 1);
  assert.equal(first.artifacts.history.supersedes_history_id, null);
  assert.ok(calls.every((call) => call.company_id === "company-a"));

  const second = await decideA(validRequest({ run_id: "run-2", idempotency_key: "idem-2" }));
  assert.equal(second.artifacts.history.revision, 2);
  assert.equal(second.artifacts.history.supersedes_history_id, first.artifacts.history.history_id);

  const decideB = bindDecisionEngine("company-b", { persistence, stages: stageAdapters([]) });
  const other = await decideB(validRequest());
  assert.equal(other.artifacts.history.revision, 1, "company-b does not see company-a history");

  assert.deepEqual(persistence.calls.load.map(([company]) => company), ["company-a", "company-a", "company-b"]);
  assert.deepEqual(persistence.calls.append.map(([company, entry]) => company + "/" + entry), [
    "company-a/company-a",
    "company-a/company-a",
    "company-b/company-b",
  ]);
});

test("a stage that returns another company fails closed and records nothing", async () => {
  const persistence = memoryPersistence();
  const stages = stageAdapters([]);
  stages.observation = () => ({ company_id: "company-b" });
  const decide = bindDecisionEngine("company-a", { persistence, stages });

  const result = await decide(validRequest());
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "cross_company_artifact");
  assert.equal(persistence.rows.length, 0);
});
