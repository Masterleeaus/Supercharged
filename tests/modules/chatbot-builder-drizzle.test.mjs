/**
 * Tests for the Drizzle builder storage (server/modules/chatbot/builder-routes/builder-storage.ts and
 * server/modules/chatbot/db/builder.ts). No database is reachable here, so the statements are built with a
 * mock client (drizzle.mock) and rendered to SQL with PgDialect. Nothing is executed.
 *
 * Checks: every statement filters by company_id, the company id is in the params, the settings write is a
 * jsonb merge, and the transaction path writes nothing else when the chatbot is not in the company.
 *
 * Run (drizzle-orm, drizzle-zod, pg, zod and express resolve from the integration scratch deps):
 *   NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" \
 *     node --test --experimental-transform-types tests/modules/chatbot-builder-drizzle.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../shared/schema.ts";

const { builderChatbotColumns, chatbotAvatars } = await import(
  "../../server/modules/chatbot/db/builder.ts"
);
const { DrizzleBuilderStorage, builderQueries } = await import(
  "../../server/modules/chatbot/builder-routes/builder-storage.ts"
);

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT_ID = "chatbot-a-1";
const NOW = new Date("2026-11-08T09:00:00.000Z");

const dialect = new PgDialect();
const db = drizzle.mock();

/** Renders a built (not awaited) query to SQL text and params. */
function render(query) {
  return dialect.sqlToQuery(query.getSQL());
}

/** Every statement the storage can run, built for company A. */
function allStatements() {
  return {
    parentState: builderQueries.parentState(db, CO_A, CHATBOT_ID),
    builderRow: builderQueries.builderRow(db, CO_A, CHATBOT_ID),
    parentUpdate: builderQueries.parentUpdate(db, CO_A, CHATBOT_ID, { title: "New", updatedAt: NOW }),
    settingsMerge: builderQueries.settingsMerge(db, CO_A, CHATBOT_ID, { bubbleMessage: "Hi", trustedDomains: ["a.com"] }),
    avatars: builderQueries.avatars(db, CO_A),
  };
}

/* ---------- schema fragment ---------- */

test("integration fix 7: the shared chatbots table is the only pgTable named chatbots", async () => {
  const builder = await import("../../server/modules/chatbot/db/builder.ts");
  assert.equal(builder.chatbotBuilderTable, undefined, "the second chatbots table must stay removed");
  const config = getTableConfig(schema.chatbots);
  assert.equal(config.name, "chatbots");
  assert.ok(!config.columns.some((c) => c.name === "builder_settings"), "builder columns are not on the shared table until the owner promotes them");
  assert.deepEqual(Object.keys(builderChatbotColumns).sort(), ["builderSettings", "publicUuid"]);
});

test("the avatars table is chatbot_avatars and carries company_id", () => {
  const config = getTableConfig(chatbotAvatars);
  assert.equal(config.name, "chatbot_avatars");
  const companyColumn = config.columns.find((c) => c.name === "company_id");
  assert.ok(companyColumn, "company_id column exists");
  assert.equal(companyColumn.notNull, false, "null company_id marks a preset");
});

/* ---------- company scoping of every statement ---------- */

test("every statement renders with a company_id predicate", () => {
  for (const [name, query] of Object.entries(allStatements())) {
    const { sql } = render(query);
    assert.match(sql, /"company_id"\s*(=|is null)/i, `${name} has a company_id predicate`);
  }
});

test("every statement carries the company id in its params", () => {
  for (const [name, query] of Object.entries(allStatements())) {
    const { params } = render(query);
    assert.ok(params.includes(CO_A), `${name} has company A in params`);
    assert.ok(!params.includes(CO_B), `${name} has no company B in params`);
  }
});

test("the company id is never interpolated into the SQL text", () => {
  for (const [name, query] of Object.entries(allStatements())) {
    const { sql } = render(query);
    assert.ok(!sql.includes(CO_A), `${name} keeps the company id out of the SQL text`);
  }
});

test("the parent state read filters by the chatbot id as well as company_id", () => {
  const { sql, params } = render(builderQueries.parentState(db, CO_A, CHATBOT_ID));
  assert.match(sql, /"chatbots"\."id"\s*=\s*\$\d/);
  assert.ok(params.includes(CHATBOT_ID));
});

test("the builder row is joined on the parent's id and company_id", () => {
  const { sql, params } = render(builderQueries.builderRow(db, CO_A, CHATBOT_ID));
  assert.match(sql, /"company_id"\s*=\s*\$\d/);
  assert.match(sql, /"id"\s*=\s*\$\d/);
  assert.ok(params.includes(CO_A));
  assert.ok(params.includes(CHATBOT_ID));
});

/* ---------- writes ---------- */

test("the parent update sets only the given classic columns and updated_at", () => {
  const { sql, params } = render(builderQueries.parentUpdate(db, CO_A, CHATBOT_ID, { title: "New", updatedAt: NOW }));
  assert.match(sql, /update "chatbots" set/i);
  assert.match(sql, /"title"\s*=\s*\$\d/);
  assert.match(sql, /"updated_at"\s*=\s*\$\d/);
  assert.ok(!/"welcome_message"\s*=/.test(sql), "untouched columns are not in the SET list");
  assert.ok(params.includes("New"));
});

test("the settings write is a jsonb merge (||), not a replacement", () => {
  const { sql, params } = render(builderQueries.settingsMerge(db, CO_A, CHATBOT_ID, { bubbleMessage: "Hi" }));
  assert.match(sql, /"builder_settings"\s*=\s*"builder_settings"\s*\|\|\s*\$\d::jsonb/);
  assert.ok(params.includes(JSON.stringify({ bubbleMessage: "Hi" })));
});

test("the settings merge is also scoped to company_id and the chatbot id", () => {
  const { sql, params } = render(builderQueries.settingsMerge(db, CO_A, CHATBOT_ID, { bubbleMessage: "Hi" }));
  assert.match(sql, /where\s+\("chatbots"\."company_id"\s*=\s*\$\d\s+and\s+"chatbots"\."id"\s*=\s*\$\d\)/i);
  assert.ok(params.includes(CO_A));
  assert.ok(params.includes(CHATBOT_ID));
});

/* ---------- avatars ---------- */

test("the avatar list reads presets and this company's uploads, and nothing else", () => {
  const { sql, params } = render(builderQueries.avatars(db, CO_A));
  assert.match(sql, /"company_id"\s+is null\s+or\s+"chatbot_avatars"\."company_id"\s*=\s*\$\d/i);
  assert.ok(params.includes(CO_A));
});

test("the avatar list puts presets first, then the company's uploads by creation time", () => {
  const { sql } = render(builderQueries.avatars(db, CO_A));
  assert.match(sql, /order by "chatbot_avatars"\."company_id" is null desc, "chatbot_avatars"\."created_at" asc/i);
});

/* ---------- storage class ---------- */

test("DrizzleBuilderStorage exposes the three BuilderStorage methods", () => {
  const storage = new DrizzleBuilderStorage(db);
  for (const name of ["findBuilderState", "updateBuilderState", "listChatbotAvatars"]) {
    assert.equal(typeof storage[name], "function", name);
  }
});

test("updateBuilderState writes nothing else when the chatbot is not in this company", async () => {
  // The parent update returns no rows, so the transaction must stop before the settings merge and the read.
  const calls = [];
  const thenable = (rows) => ({
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  });
  const tx = {
    update(table) {
      calls.push({ table });
      return {
        set(values) {
          calls[calls.length - 1].values = values;
          return {
            where() {
              return {
                returning: async () => [],
                ...thenable([]),
              };
            },
          };
        },
      };
    },
  };
  const stubDb = { transaction: async (fn) => fn(tx) };
  const storage = new DrizzleBuilderStorage(stubDb);

  const result = await storage.updateBuilderState(
    CO_B,
    CHATBOT_ID,
    { chatbot: { title: "Hijacked" }, settings: { bubbleMessage: "x" } },
    NOW,
  );

  assert.equal(result, null);
  assert.equal(calls.length, 1, "only the parent update was attempted");
  assert.equal(calls[0].table, schema.chatbots, "the one attempted write is the parent table");
});
