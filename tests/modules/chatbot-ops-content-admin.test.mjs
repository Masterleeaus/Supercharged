// Ops and content-admin gap tests: contacts adapter, analytics counts for bookings and orders, article read port,
// canned responses across companies, and attachment storage paths. No network and no real database.
// Drizzle queries are rendered with PgDialect; the pool is never connected.
//
// Run:
//   NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" \
//     node --test --experimental-transform-types tests/modules/chatbot-ops-content-admin.test.mjs
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { createContactReader, toContactSummary } from "../../server/modules/chatbot/content-admin/contacts-adapter.ts";
import { createArticleReadPort } from "../../server/modules/chatbot/content-admin/article-read-port.ts";
import { createMemoryContentAdminStorage } from "../../server/modules/chatbot/content-admin/memory-storage.ts";
import { ChatbotAnalytics, summariseWindow } from "../../server/modules/chatbot/ops/analytics.ts";
import { AttachmentService, attachmentStorageKey } from "../../server/modules/chatbot/ops/attachments.ts";
import { InMemoryAttachmentMeta, InMemoryBlobStore } from "../../server/modules/chatbot/ops/memory-storage.ts";
import { buildLoadBookingRows, buildLoadOrderRows, DrizzleAnalyticsSource } from "../../server/modules/chatbot/ops/drizzle-storage.ts";

const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";
const SIGNING_KEY = "test-only-signing-key-0123456789abcdef";
const FIXED_ID = "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";
const NOW = new Date("2026-11-08T10:00:00Z");
const FROM = new Date("2026-11-01T00:00:00Z");
const TO = new Date("2026-11-30T00:00:00Z");

const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });
const db = drizzle(pool);
const dialect = new PgDialect();
after(async () => {
  await pool.end();
});

// ---------- contacts adapter ----------

function customer(overrides) {
  return {
    id: "cust-1",
    companyId: COMPANY_A,
    userId: null,
    avatar: null,
    name: "Ana",
    email: "ana@example.test",
    phone: "+61400000001",
    chatbotId: "bot-a",
    sessionId: "session-secret-1",
    countryCode: "AU",
    ipAddress: "203.0.113.7",
    chatbotChannel: "web",
    enabledSound: true,
    preferredLanguage: "en",
    communicationPreferences: { sms: true },
    payload: { note: "private payload" },
    createdAt: new Date("2026-11-02T00:00:00Z"),
    updatedAt: new Date("2026-11-02T00:00:00Z"),
    ...overrides,
  };
}

/** A fake of the customers storage that returns whatever rows it is given, including another company's. */
function fakeCustomers(rows) {
  return {
    async listCustomers() {
      return rows.map((row) => ({ ...row }));
    },
    async findCustomer(_companyId, id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
  };
}

test("contacts adapter lists only the company's contacts, even when storage returns another company's row", async () => {
  const reader = createContactReader(
    fakeCustomers([
      customer({ id: "cust-a", companyId: COMPANY_A }),
      customer({ id: "cust-b", companyId: COMPANY_B, name: "Other company" }),
    ]),
  );
  const rows = await reader.listContacts(COMPANY_A);
  assert.deepEqual(rows.map((r) => r.id), ["cust-a"]);
  assert.ok(rows.every((r) => r.companyId === COMPANY_A));
});

test("contacts adapter treats another company's contact as absent", async () => {
  const reader = createContactReader(fakeCustomers([customer({ id: "cust-b", companyId: COMPANY_B })]));
  assert.equal(await reader.findContact(COMPANY_A, "cust-b"), null);
  const own = await reader.findContact(COMPANY_B, "cust-b");
  assert.equal(own?.id, "cust-b");
});

test("contacts adapter returns only the view fields, never ip address, session or payload", async () => {
  const summary = toContactSummary(customer({}));
  const keys = Object.keys(summary).sort();
  assert.deepEqual(keys, [
    "chatbotChannel",
    "chatbotId",
    "companyId",
    "createdAt",
    "email",
    "id",
    "name",
    "phone",
    "preferredLanguage",
  ]);
  const json = JSON.stringify(summary);
  for (const secret of ["203.0.113.7", "session-secret-1", "private payload", "AU"]) {
    assert.equal(json.includes(secret), false, `leaked ${secret}`);
  }
});

test("contacts adapter refuses a missing company before it reads", async () => {
  const reader = createContactReader(fakeCustomers([customer({})]));
  await assert.rejects(reader.listContacts(""), (err) => err.status === 403);
  await assert.rejects(reader.findContact("", "cust-1"), (err) => err.status === 403);
});

// ---------- analytics counts ----------

function conversation(id, companyId, chatbotId = "bot") {
  return {
    id,
    companyId,
    chatbotId,
    channel: "web",
    createdAt: new Date("2026-11-05T09:00:00Z"),
    connectAgentAt: null,
    ticketStatus: "open",
  };
}

test("booking and order counts never mix companies, in the pure aggregation", () => {
  const window = {
    conversations: [conversation("c-a", COMPANY_A)],
    messages: [],
    bookingRows: [
      { companyId: COMPANY_A, createdAt: new Date("2026-11-03T10:00:00Z") },
      { companyId: COMPANY_A, createdAt: new Date("2026-11-04T10:00:00Z") },
      { companyId: COMPANY_B, createdAt: new Date("2026-11-03T11:00:00Z") },
      { companyId: COMPANY_B, createdAt: new Date("2026-11-03T12:00:00Z") },
      { companyId: COMPANY_B, createdAt: new Date("2026-11-03T13:00:00Z") },
    ],
    orderRows: [
      { companyId: COMPANY_B, placedAt: new Date("2026-11-06T10:00:00Z") },
      { companyId: COMPANY_A, placedAt: new Date("2026-11-06T11:00:00Z") },
    ],
  };
  const [row] = summariseWindow(COMPANY_A, window, {
    metrics: ["bookings_created", "orders_placed", "conversations"],
    from: FROM,
    to: TO,
    groupBy: null,
  });
  assert.equal(row.values.bookings_created, 2);
  assert.equal(row.values.orders_placed, 1);
  assert.equal(row.values.conversations, 1);
});

test("the company-tagged rows count in the right range only", () => {
  const window = {
    conversations: [],
    messages: [],
    bookingRows: [
      { companyId: COMPANY_A, createdAt: new Date("2026-10-31T23:59:59Z") },
      { companyId: COMPANY_A, createdAt: new Date("2026-11-30T00:00:00Z") },
      { companyId: COMPANY_A, createdAt: new Date("2026-11-15T00:00:00Z") },
    ],
  };
  const [row] = summariseWindow(COMPANY_A, window, { metrics: ["bookings_created"], from: FROM, to: TO, groupBy: null });
  assert.equal(row.values.bookings_created, 1);
});

test("ChatbotAnalytics answers only for the requested company, even when the source returns both", async () => {
  const source = {
    async load() {
      return {
        conversations: [conversation("c-a", COMPANY_A, "bot-a"), conversation("c-b", COMPANY_B, "bot-b")],
        messages: [],
        bookingRows: [
          { companyId: COMPANY_A, createdAt: new Date("2026-11-03T10:00:00Z") },
          { companyId: COMPANY_B, createdAt: new Date("2026-11-03T10:00:00Z") },
        ],
        orderRows: [{ companyId: COMPANY_B, placedAt: new Date("2026-11-03T10:00:00Z") }],
      };
    },
  };
  const analytics = new ChatbotAnalytics(source);
  const rows = await analytics.run(COMPANY_A, {
    metrics: ["conversations", "bookings_created", "orders_placed"],
    from: FROM,
    to: TO,
    groupBy: null,
  });
  assert.equal(rows[0].values.conversations, 1);
  assert.equal(rows[0].values.bookings_created, 1);
  assert.equal(rows[0].values.orders_placed, 0);
  const top = await analytics.topChatbots(COMPANY_B, FROM, TO);
  assert.deepEqual(top, [{ key: "bot-b", count: 1 }]);
});

test("the Drizzle booking and order counts are company-filtered and status-filtered", () => {
  const booking = dialect.sqlToQuery(buildLoadBookingRows(db, COMPANY_A, FROM, TO).getSQL());
  assert.ok(booking.params.includes(COMPANY_A));
  assert.equal(booking.params.includes(COMPANY_B), false);
  assert.ok(booking.params.includes("confirmed"));
  assert.match(booking.sql, /"company_id"/);

  const order = dialect.sqlToQuery(buildLoadOrderRows(db, COMPANY_A, FROM, TO).getSQL());
  assert.ok(order.params.includes(COMPANY_A));
  assert.equal(order.params.includes(COMPANY_B), false);
  assert.ok(order.params.includes("cancelled"));
  assert.match(order.sql, /"placed_at"/);
});

test("the Drizzle analytics source refuses a missing company before it queries", async () => {
  const source = new DrizzleAnalyticsSource(db);
  await assert.rejects(source.load("", FROM, TO), (err) => err.status === 403);
});

// ---------- canned responses across companies ----------

test("a canned response from another company is not listed, read, changed or deleted", async () => {
  const storage = createMemoryContentAdminStorage();
  const row = await storage.insertCannedResponse(COMPANY_A, { title: "Hours", content: "Open 9 to 5." }, null, NOW);

  assert.deepEqual(await storage.listCannedResponses(COMPANY_B), []);
  assert.equal(await storage.findCannedResponse(COMPANY_B, row.id), null);
  assert.equal(await storage.updateCannedResponse(COMPANY_B, row.id, { content: "changed" }, NOW), null);
  assert.equal(await storage.deleteCannedResponse(COMPANY_B, row.id), false);

  const still = await storage.findCannedResponse(COMPANY_A, row.id);
  assert.equal(still?.content, "Open 9 to 5.");
});

// ---------- article read port ----------

test("the article read port returns only the company's linked articles that have content", async () => {
  const storage = createMemoryContentAdminStorage({ [COMPANY_A]: ["bot-a"], [COMPANY_B]: ["bot-b"] });
  const port = createArticleReadPort(storage);
  await storage.insertArticle(
    COMPANY_A,
    { title: "Refunds", description: "How refunds work", content: "Refunds take 5 days.", isFeatured: false, chatbotIds: ["bot-a"] },
    null,
    NOW,
  );
  await storage.insertArticle(
    COMPANY_A,
    { title: "Pricing", description: "Prices", content: "Prices start at $10.", isFeatured: true, chatbotIds: ["bot-a"] },
    null,
    NOW,
  );
  await storage.insertArticle(
    COMPANY_A,
    { title: "Draft", description: "Not written yet", content: null, isFeatured: true, chatbotIds: ["bot-a"] },
    null,
    NOW,
  );
  await storage.insertArticle(
    COMPANY_B,
    { title: "Other", description: "Other company", content: "Secret other text.", isFeatured: true, chatbotIds: ["bot-a"] },
    null,
    NOW,
  );

  const forA = await port.listForChatbot(COMPANY_A, "bot-a");
  assert.deepEqual(forA.map((a) => a.title), ["Pricing", "Refunds"], "featured first, then title; drafts left out");
  assert.ok(!JSON.stringify(forA).includes("Secret other text."));

  assert.deepEqual(await port.listForChatbot(COMPANY_A, ""), []);
  assert.deepEqual(await port.listForChatbot(COMPANY_A, "bot-x"), []);
});

test("an article from another company that names the same chatbot id is never returned", async () => {
  const storage = createMemoryContentAdminStorage();
  const port = createArticleReadPort(storage);
  await storage.insertArticle(
    COMPANY_B,
    { title: "Other", description: "d", content: "Other company text.", isFeatured: false, chatbotIds: ["bot-a"] },
    null,
    NOW,
  );
  assert.deepEqual(await port.listForChatbot(COMPANY_A, "bot-a"), []);
});

// ---------- attachments ----------

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% test bytes only\n");

function attachmentService(overrides = {}) {
  const blobs = new InMemoryBlobStore();
  const meta = new InMemoryAttachmentMeta();
  const service = new AttachmentService({
    meta,
    blobs,
    signingKey: SIGNING_KEY,
    now: () => NOW,
    newId: () => FIXED_ID,
    ...overrides,
  });
  return { service, blobs, meta };
}

test("the attachment storage key never contains the original filename", async () => {
  const { service, blobs } = attachmentService();
  const filename = "Jason-passport-scan-2026.pdf";
  const record = await service.put(COMPANY_A, { filename, contentType: "application/pdf", bytes: PDF_BYTES });

  assert.equal(record.storageKey, attachmentStorageKey(COMPANY_A, FIXED_ID));
  assert.equal(record.storageKey.toLowerCase().includes("passport"), false);
  assert.deepEqual(blobs.writtenKeys, [record.storageKey]);
});

test("path tricks in the filename do not reach the storage key or the download link", async () => {
  const { service, blobs } = attachmentService();
  const filename = "../../etc/passwd%2e%2e/evil name.pdf";
  const record = await service.put(COMPANY_A, { filename, contentType: "application/pdf", bytes: PDF_BYTES });

  assert.equal(record.storageKey, `chatbot/attachments/${COMPANY_A}/${FIXED_ID}`);
  assert.equal(blobs.writtenKeys[0].includes(".."), false);
  assert.equal(blobs.writtenKeys[0].includes("evil"), false);

  const url = await service.readUrl(COMPANY_A, FIXED_ID, 60);
  assert.ok(url);
  assert.equal(url.includes("passwd"), false);
  assert.equal(url.includes("evil"), false);
});

test("an attachment of another company is not readable and its link does not verify", async () => {
  const { service } = attachmentService();
  await service.put(COMPANY_A, { filename: "a.pdf", contentType: "application/pdf", bytes: PDF_BYTES });

  assert.equal(await service.get(COMPANY_B, FIXED_ID), null);
  assert.equal(await service.readUrl(COMPANY_B, FIXED_ID, 60), null);

  const url = await service.readUrl(COMPANY_A, FIXED_ID, 60);
  const params = new URL(url, "https://desk.test").searchParams;
  const token = { expires: Number(params.get("expires")), signature: params.get("sig") };
  assert.equal(await service.verifyDownload(COMPANY_B, FIXED_ID, token), false);
  assert.equal(await service.verifyDownload(COMPANY_A, FIXED_ID, token), true);
});

test("the attachment service refuses to start with a short signing key", () => {
  assert.throws(
    () => new AttachmentService({ meta: new InMemoryAttachmentMeta(), blobs: new InMemoryBlobStore(), signingKey: "short" }),
    (err) => /CHATBOT_SECRET_KEY/.test(err.message) && !err.message.includes("test-only"),
  );
});
