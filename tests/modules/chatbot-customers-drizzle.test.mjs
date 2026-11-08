// Chatbot customers: Drizzle storage tests (node:test). No database is reached.
// The queries are rendered with PgDialect.sqlToQuery(query.getSQL()) and checked for a company_id predicate
// and the company id in the params. A stub client answers the statements without a connection.
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";
import { DrizzleCustomerStorage } from "../../server/modules/chatbot/db/customers-storage.ts";
import {
  chatbotContactIdentities,
  chatbotConversationCustomerTags,
  chatbotCustomerConversations,
  chatbotCustomers,
  chatbotCustomerTags,
} from "../../server/modules/chatbot/db/customers.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "cust-1";
const SOURCE_ID = "cust-2";
const TAG_ID = "tag-1";
const CONVERSATION_ID = "conv-1";
const NOW = new Date("2026-11-08T10:00:00.000Z");

// The storage interface, copied from customer-storage.ts. The test fails if either side changes alone.
const INTERFACE_METHODS = [
  "insertCustomer",
  "findCustomer",
  "listCustomers",
  "updateCustomer",
  "deleteCustomer",
  "upsertIdentity",
  "findIdentity",
  "findIdentitiesByNormalizedValue",
  "listIdentitiesForCustomer",
  "deleteIdentitiesForCustomer",
  "linkConversationCustomer",
  "findConversationCustomerId",
  "unlinkCustomerConversations",
  "mergeCustomers",
  "insertTag",
  "findTag",
  "listTags",
  "updateTag",
  "deleteTag",
  "listTagIdsForConversation",
  "setTagAssignments",
  "addTagAssignment",
  "removeTagAssignment",
];

const dialect = new PgDialect();

/** Renders a captured query builder to SQL text and params, without running it. */
function render(query) {
  return dialect.sqlToQuery(query.getSQL());
}

/**
 * Builds a storage whose queries are captured and answered by a stub client.
 * `respond(text)` may return rows for a statement. Default is no rows.
 */
function defaultRespond(text) {
  // Insert and update statements with RETURNING get one row back, as a real database would.
  return /^(insert|update)/i.test(text) && /returning/i.test(text) ? [{}] : [];
}

function harness(respond = defaultRespond) {
  const captured = [];
  const executed = [];
  const client = {
    query: async (config) => {
      executed.push(config.text);
      return { rows: respond(config.text), rowCount: 0 };
    },
  };
  const db = drizzle({ client });
  const storage = new DrizzleCustomerStorage(db, { onQuery: (query) => captured.push(query) });
  return { storage, captured, executed };
}

function assertScoped(rendered, companyId) {
  if (/^insert /i.test(rendered.sql)) {
    assert.match(rendered.sql, /"company_id"/, `insert without company_id: ${rendered.sql}`);
  } else {
    assert.match(rendered.sql, /"company_id" = \$\d+/, `statement without company_id predicate: ${rendered.sql}`);
  }
  assert.ok(rendered.params.includes(companyId), `company id missing from params: ${rendered.sql}`);
}

const SCENARIOS = [
  ["insertCustomer", (s) => s.insertCustomer(COMPANY_A, { name: "Ana" }, NOW)],
  ["findCustomer", (s) => s.findCustomer(COMPANY_A, CUSTOMER_ID)],
  ["listCustomers", (s) => s.listCustomers(COMPANY_A)],
  ["updateCustomer", (s) => s.updateCustomer(COMPANY_A, CUSTOMER_ID, { name: "Bo" }, NOW)],
  ["deleteCustomer", (s) => s.deleteCustomer(COMPANY_A, CUSTOMER_ID)],
  [
    "upsertIdentity",
    (s) =>
      s.upsertIdentity(
        COMPANY_A,
        { customerId: CUSTOMER_ID, channel: "sms", identifier: "0412 345 678", normalizedIdentifier: "0412345678", metadata: {} },
        NOW,
      ),
  ],
  ["findIdentity", (s) => s.findIdentity(COMPANY_A, "sms", "0412345678")],
  ["findIdentitiesByNormalizedValue", (s) => s.findIdentitiesByNormalizedValue(COMPANY_A, "0412345678")],
  ["listIdentitiesForCustomer", (s) => s.listIdentitiesForCustomer(COMPANY_A, CUSTOMER_ID)],
  ["deleteIdentitiesForCustomer", (s) => s.deleteIdentitiesForCustomer(COMPANY_A, CUSTOMER_ID)],
  ["linkConversationCustomer", (s) => s.linkConversationCustomer(COMPANY_A, CONVERSATION_ID, CUSTOMER_ID)],
  ["findConversationCustomerId", (s) => s.findConversationCustomerId(COMPANY_A, CONVERSATION_ID)],
  ["unlinkCustomerConversations", (s) => s.unlinkCustomerConversations(COMPANY_A, CUSTOMER_ID)],
  ["mergeCustomers", (s) => s.mergeCustomers(COMPANY_A, CUSTOMER_ID, SOURCE_ID, NOW)],
  ["insertTag", (s) => s.insertTag(COMPANY_A, { tag: "vip", tagColor: "#000000", backgroundColor: null }, NOW)],
  ["findTag", (s) => s.findTag(COMPANY_A, TAG_ID)],
  ["listTags", (s) => s.listTags(COMPANY_A)],
  ["updateTag", (s) => s.updateTag(COMPANY_A, TAG_ID, { tag: "gold" }, NOW)],
  ["deleteTag", (s) => s.deleteTag(COMPANY_A, TAG_ID)],
  ["listTagIdsForConversation", (s) => s.listTagIdsForConversation(COMPANY_A, CONVERSATION_ID)],
  ["setTagAssignments", (s) => s.setTagAssignments(COMPANY_A, CONVERSATION_ID, [TAG_ID], NOW)],
  ["addTagAssignment", (s) => s.addTagAssignment(COMPANY_A, CONVERSATION_ID, TAG_ID, NOW)],
  ["removeTagAssignment", (s) => s.removeTagAssignment(COMPANY_A, CONVERSATION_ID, TAG_ID)],
];

// ---------- interface parity ----------

test("DrizzleCustomerStorage implements every CustomerStorage method and nothing else", () => {
  const own = Object.getOwnPropertyNames(DrizzleCustomerStorage.prototype)
    .filter((name) => name !== "constructor" && !name.startsWith("_") && name !== "q" && name !== "mergeWith");
  assert.deepEqual([...own].sort(), [...INTERFACE_METHODS].sort());
});

test("every interface method has a rendered scenario in this file", () => {
  assert.deepEqual(SCENARIOS.map(([name]) => name).sort(), [...INTERFACE_METHODS].sort());
});

// ---------- company scope on every statement ----------

test("every statement from every method filters by company_id and carries the company id", async () => {
  for (const [name, call] of SCENARIOS) {
    const { storage, captured } = harness();
    await call(storage);
    assert.ok(captured.length > 0, `${name} produced no statement`);
    for (const query of captured) {
      assertScoped(render(query), COMPANY_A);
    }
  }
});

test("a statement never carries the other company's id", async () => {
  for (const [name, call] of SCENARIOS) {
    const { storage, captured } = harness();
    await call(storage);
    for (const query of captured) {
      assert.ok(!render(query).params.includes(COMPANY_B), `${name} leaked company B`);
    }
  }
});

test("a missing or malformed company id is refused before any statement runs", async () => {
  for (const bad of [undefined, null, "", "not-a-uuid"]) {
    const { storage, captured } = harness();
    await assert.rejects(storage.findCustomer(bad, CUSTOMER_ID), (err) => err instanceof ChatbotError && err.status === 403);
    await assert.rejects(storage.listTags(bad), (err) => err instanceof ChatbotError && err.status === 403);
    assert.equal(captured.length, 0);
  }
});

// ---------- schema: tenancy at the table level ----------

const TABLES = [chatbotCustomers, chatbotContactIdentities, chatbotCustomerConversations, chatbotCustomerTags, chatbotConversationCustomerTags];

test("every customers table has a NOT NULL company_id column", () => {
  for (const table of TABLES) {
    const config = getTableConfig(table);
    const column = config.columns.find((col) => col.name === "company_id");
    assert.ok(column, `${config.name} has no company_id`);
    assert.equal(column.notNull, true, `${config.name}.company_id must be NOT NULL`);
  }
});

test("every foreign key on a customers table includes company_id as its first column", () => {
  for (const table of TABLES) {
    const config = getTableConfig(table);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      assert.equal(ref.columns[0].name, "company_id", `${config.name} FK ${fk.getName()} is not company-scoped`);
      assert.equal(ref.foreignColumns[0].name, "company_id", `${config.name} FK ${fk.getName()} points outside the company`);
    }
  }
});

test("contact identity uniqueness is per company: (company_id, channel, normalized_identifier)", () => {
  const config = getTableConfig(chatbotContactIdentities);
  const unique = config.indexes.find((index) => index.config.name === "chatbot_contact_identities_company_value_uidx");
  assert.ok(unique, "identity unique index missing");
  assert.equal(unique.config.unique, true);
  assert.deepEqual(
    unique.config.columns.map((col) => col.name),
    ["company_id", "channel", "normalized_identifier"],
  );
  // No index may enforce uniqueness on the value alone, which would be global.
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    assert.ok(index.config.columns.some((col) => col.name === "company_id"), `${index.config.name} is not company-scoped`);
  }
});

test("a conversation has at most one customer link per company", () => {
  const config = getTableConfig(chatbotCustomerConversations);
  const unique = config.indexes.find((index) => index.config.unique);
  assert.deepEqual(unique.config.columns.map((col) => col.name), ["company_id", "conversation_id"]);
});

test("a tag is assigned to a conversation at most once per company", () => {
  const config = getTableConfig(chatbotConversationCustomerTags);
  const unique = config.indexes.find((index) => index.config.unique);
  assert.deepEqual(unique.config.columns.map((col) => col.name), ["company_id", "conversation_id", "customer_tag_id"]);
});

// ---------- specific statement shapes ----------

test("identity upsert conflicts on the per-company key, not on the value alone", async () => {
  const { storage, captured } = harness();
  await storage.upsertIdentity(
    COMPANY_A,
    { customerId: CUSTOMER_ID, channel: "sms", identifier: "0412 345 678", normalizedIdentifier: "0412345678", metadata: {} },
    NOW,
  );
  const sql = render(captured[0]).sql;
  assert.match(sql, /on conflict \("company_id", ?"channel", ?"normalized_identifier"\)/);
});

test("merge runs select, identity move, conversation move, source delete, in that order", async () => {
  const { storage, captured } = harness((text) =>
    /^select/i.test(text) && text.includes("chatbot_customers")
      ? [{ id: CUSTOMER_ID }, { id: SOURCE_ID }]
      : defaultRespond(text),
  );
  const result = await storage.mergeCustomers(COMPANY_A, CUSTOMER_ID, SOURCE_ID, NOW);
  assert.deepEqual(result, { identitiesMoved: 1, conversationsMoved: 1 });
  const statements = captured.map((query) => render(query).sql);
  assert.equal(statements.length, 4);
  assert.match(statements[0], /^select/i);
  assert.match(statements[1], /^update "chatbot_contact_identities"/i);
  assert.match(statements[2], /^update "chatbot_customer_conversations"/i);
  assert.match(statements[3], /^delete from "chatbot_customers"/i);
});

test("merge refuses a self-merge without any statement", async () => {
  const { storage, captured } = harness();
  assert.equal(await storage.mergeCustomers(COMPANY_A, CUSTOMER_ID, CUSTOMER_ID, NOW), null);
  assert.equal(captured.length, 0);
});

test("merge returns null and changes nothing when a customer is missing", async () => {
  const { storage, captured } = harness();
  assert.equal(await storage.mergeCustomers(COMPANY_A, CUSTOMER_ID, SOURCE_ID, NOW), null);
  assert.equal(captured.length, 1, "only the existence check should run");
  assert.match(render(captured[0]).sql, /^select/i);
});

test("deleting a tag removes its assignments before the tag itself", async () => {
  const { storage, captured } = harness((text) => (/^select/i.test(text) ? [{ id: TAG_ID }] : []));
  assert.equal(await storage.deleteTag(COMPANY_A, TAG_ID), true);
  const statements = captured.map((query) => render(query).sql);
  assert.match(statements[1], /^delete from "chatbot_conversation_customer_tags"/i);
  assert.match(statements[2], /^delete from "chatbot_customer_tags"/i);
});

test("setTagAssignments checks tag ownership in the company before it writes", async () => {
  const { storage, captured } = harness((text) => (/^select/i.test(text) ? [{ id: TAG_ID }] : []));
  await storage.setTagAssignments(COMPANY_A, CONVERSATION_ID, [TAG_ID, TAG_ID, "unknown-tag"], NOW);
  const statements = captured.map((query) => render(query));
  assert.match(statements[0].sql, /^select/i);
  assert.match(statements[0].sql, /"company_id" = \$\d+/);
  assert.ok(statements[0].params.includes("unknown-tag"));
  assert.match(statements[1].sql, /^delete from "chatbot_conversation_customer_tags"/i);
  assert.match(statements[2].sql, /^insert into "chatbot_conversation_customer_tags"/i);
});

test("addTagAssignment is a no-op on a repeat pair (on conflict do nothing on the company pair)", async () => {
  const { storage, captured } = harness((text) => (/^select/i.test(text) ? [{ id: TAG_ID }] : []));
  await storage.addTagAssignment(COMPANY_A, CONVERSATION_ID, TAG_ID, NOW);
  const insert = render(captured[1]).sql;
  assert.match(insert, /on conflict \("company_id", ?"conversation_id", ?"customer_tag_id"\) do nothing/);
});

test("addTagAssignment refuses a tag that is not in the company", async () => {
  const { storage, captured } = harness();
  assert.equal(await storage.addTagAssignment(COMPANY_A, CONVERSATION_ID, TAG_ID, NOW), false);
  assert.equal(captured.length, 1, "only the tag lookup should run");
});
