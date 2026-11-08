import { test } from "node:test";
import assert from "node:assert/strict";
import { createHasHumanAgents, HUMAN_AGENT_ROLE, type ActiveAgentLookup } from "./has-human-agents.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SECRET = "postgres://user:hunter2@db/secret";

function fakeLookup(answers: Record<string, boolean>) {
  const calls: string[] = [];
  const lookup: ActiveAgentLookup = {
    hasActiveAgent: async (companyId: string) => {
      calls.push(companyId);
      return answers[companyId] ?? false;
    },
  };
  return { lookup, calls };
}

test("role used for the fallback rule is agent", () => {
  assert.equal(HUMAN_AGENT_ROLE, "agent");
});

test("true when the company has an active agent", async () => {
  const { lookup, calls } = fakeLookup({ [COMPANY_A]: true });
  const check = createHasHumanAgents({ lookup });
  assert.equal(await check(COMPANY_A), true);
  assert.deepEqual(calls, [COMPANY_A]);
});

test("false when the company has no active agent", async () => {
  const { lookup } = fakeLookup({ [COMPANY_A]: false });
  const check = createHasHumanAgents({ lookup });
  assert.equal(await check(COMPANY_A), false);
});

test("scopes each answer to the requested company", async () => {
  const { lookup } = fakeLookup({ [COMPANY_A]: true, [COMPANY_B]: false });
  const check = createHasHumanAgents({ lookup });
  assert.equal(await check(COMPANY_A), true);
  assert.equal(await check(COMPANY_B), false);
});

test("a non-UUID company id is refused without querying", async () => {
  const { lookup, calls } = fakeLookup({ "not-a-uuid": true });
  const check = createHasHumanAgents({ lookup });
  assert.equal(await check("not-a-uuid"), false);
  assert.equal(await check(""), false);
  assert.deepEqual(calls, []);
});

test("a lookup that throws returns false, reports to onError, and does not leak the error", async () => {
  const seen: unknown[] = [];
  const lookup: ActiveAgentLookup = {
    hasActiveAgent: async () => {
      throw new Error(`connection failed: ${SECRET}`);
    },
  };
  const check = createHasHumanAgents({ lookup, onError: (err) => seen.push(err) });
  const result = await check(COMPANY_A);
  assert.equal(result, false);
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
});

test("a throw with no onError still returns false", async () => {
  const lookup: ActiveAgentLookup = {
    hasActiveAgent: async () => {
      throw new Error("boom");
    },
  };
  const check = createHasHumanAgents({ lookup });
  assert.equal(await check(COMPANY_A), false);
});

test("a lookup that resolves a non-true value is refused", async () => {
  const lookup = { hasActiveAgent: async () => "yes" as unknown as boolean } satisfies ActiveAgentLookup;
  const check = createHasHumanAgents({ lookup });
  assert.equal(await check(COMPANY_A), false);
});
