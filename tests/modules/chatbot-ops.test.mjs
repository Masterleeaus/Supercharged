// Ops slice tests (node:test). Attachments, analytics, conversation export, health and metrics.
// No network and no real database: Drizzle queries are rendered with PgDialect and the pool is never connected.
// Covers: the type and size allow-list, a storage path that never contains the original filename, signed and
// company-bound downloads, analytics per company, an export that contains only the company's rows, a PDF 501,
// and a health report with no key or token in it.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentService,
  DOWNLOAD_TTL_MAX_SECONDS,
  findBlockedExtension,
  sanitiseFilename,
} from "../../server/modules/chatbot/ops/attachments.ts";
import { ChatbotAnalytics, summariseWindow } from "../../server/modules/chatbot/ops/analytics.ts";
import { exportConversation, renderExport, safeFileStem } from "../../server/modules/chatbot/ops/export.ts";
import { MetricsRegistry, buildHealthReport } from "../../server/modules/chatbot/ops/health.ts";
import { InMemoryAttachmentMeta, InMemoryBlobStore } from "../../server/modules/chatbot/ops/memory-storage.ts";
import {
  buildChatbotTitle,
  buildFindAttachment,
  buildFindExportConversation,
  buildInsertAttachment,
  buildListExportMessages,
  buildLoadConversationsWindow,
  buildLoadMessagesWindow,
  buildMarkAttachmentDeleted,
} from "../../server/modules/chatbot/ops/drizzle-storage.ts";
import { ChatbotError } from "../../server/modules/chatbot/chatbot-scope.ts";

// ---------- fixtures ----------

const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";
const SIGNING_KEY = "test-only-signing-key-0123456789abcdef";
const FIXED_ID = "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";
const NOW = new Date("2026-11-08T10:00:00Z");

// Never connected: the pool only lets drizzle build queries against a real dialect.
const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });
const db = drizzle(pool);
after(() => pool.end());

const dialect = new PgDialect();
const render = (query) => dialect.sqlToQuery(query.getSQL());
const enc = new TextEncoder();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PDF = enc.encode("%PDF-1.7\n1 0 obj\n");
const CSV = enc.encode("name,amount\nrent,100\n");

function makeService(overrides = {}) {
  const meta = new InMemoryAttachmentMeta();
  const blobs = new InMemoryBlobStore();
  let clock = NOW;
  let counter = 0;
  const service = new AttachmentService({
    meta,
    blobs,
    signingKey: SIGNING_KEY,
    now: () => clock,
    newId: () => `0f9e8d7c-6b5a-4f3e-8d2c-${String(++counter).padStart(12, "0")}`,
    ...overrides,
  });
  return { service, meta, blobs, setClock: (date) => (clock = date) };
}

async function expectChatbotError(promise, status) {
  await assert.rejects(promise, (error) => error instanceof ChatbotError && error.status === status);
}

// ---------- attachments: allow-list ----------

test("allow-list accepts a PNG whose bytes match, and returns the record", async () => {
  const { service, blobs } = makeService();
  const record = await service.put(COMPANY_A, { filename: "photo.png", contentType: "image/png", bytes: PNG });
  assert.equal(record.contentType, "image/png");
  assert.equal(record.sizeBytes, PNG.byteLength);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.companyId, COMPANY_A);
  assert.ok(blobs.has(record.storageKey));
});

test("content type parameters are ignored when checking the allow-list", async () => {
  const { service } = makeService();
  const record = await service.put(COMPANY_A, { filename: "notes.txt", contentType: "Text/Plain; charset=utf-8", bytes: enc.encode("hello") });
  assert.equal(record.contentType, "text/plain");
});

test("allow-list refuses a type that is not on it", async () => {
  const { service, blobs } = makeService();
  await expectChatbotError(
    service.put(COMPANY_A, { filename: "tool.msi", contentType: "application/x-msdownload", bytes: PNG }),
    415,
  );
  assert.equal(blobs.writtenKeys.length, 0, "nothing is written when validation fails");
});

test("blocked extensions are refused, including a double extension that hides one", async () => {
  const { service } = makeService();
  await expectChatbotError(service.put(COMPANY_A, { filename: "run.sh", contentType: "text/plain", bytes: enc.encode("echo") }), 415);
  await expectChatbotError(service.put(COMPANY_A, { filename: "invoice.php.png", contentType: "image/png", bytes: PNG }), 415);
  assert.equal(findBlockedExtension("invoice.php.png"), "php");
  assert.equal(findBlockedExtension("invoice.pdf"), null);
});

test("bytes that do not match the declared type are refused", async () => {
  const { service } = makeService();
  await expectChatbotError(service.put(COMPANY_A, { filename: "x.jpg", contentType: "image/jpeg", bytes: PNG }), 422);
  await expectChatbotError(service.put(COMPANY_A, { filename: "x.txt", contentType: "text/plain", bytes: new Uint8Array([0x68, 0, 0x69]) }), 422);
  await expectChatbotError(service.put(COMPANY_A, { filename: "x.txt", contentType: "text/plain", bytes: new Uint8Array([0xff, 0xfe, 0xfa]) }), 422);
});

test("each allowed binary type is recognised by its own signature", async () => {
  const { service } = makeService();
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  await service.put(COMPANY_A, { filename: "a.jpg", contentType: "image/jpeg", bytes: JPEG });
  await service.put(COMPANY_A, { filename: "a.pdf", contentType: "application/pdf", bytes: PDF });
  await service.put(COMPANY_A, { filename: "a.csv", contentType: "text/csv", bytes: CSV });
  await service.put(COMPANY_A, { filename: "a.mp4", contentType: "video/mp4", bytes: mp4 });
  await expectChatbotError(service.put(COMPANY_A, { filename: "a.mp4", contentType: "video/mp4", bytes: PNG }), 422);
});

test("size limit: default is 20 MiB, and an upload over the limit is refused before storage", async () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 20 * 1024 * 1024);
  const { service, blobs } = makeService({ maxBytes: 16 });
  await expectChatbotError(
    service.put(COMPANY_A, { filename: "big.txt", contentType: "text/plain", bytes: enc.encode("0123456789abcdefX") }),
    413,
  );
  await expectChatbotError(service.put(COMPANY_A, { filename: "empty.txt", contentType: "text/plain", bytes: new Uint8Array(0) }), 422);
  assert.equal(blobs.writtenKeys.length, 0);
});

// ---------- attachments: storage path ----------

test("storage key never contains the original filename, and is built from the company and a random id", async () => {
  const { service, blobs } = makeService({ newId: () => FIXED_ID });
  const record = await service.put(COMPANY_A, { filename: "quarterly-payroll-zq9.png", contentType: "image/png", bytes: PNG });
  assert.equal(record.storageKey, `chatbot/attachments/${COMPANY_A}/${FIXED_ID}`);
  assert.ok(!record.storageKey.includes("payroll"));
  assert.ok(!record.storageKey.includes("zq9"));
  assert.deepEqual(blobs.writtenKeys, [record.storageKey]);
});

test("display name is sanitised: separators and control characters become dashes, and no path survives", () => {
  assert.equal(sanitiseFilename("../../etc/pass\u0000wd.txt"), "..-..-etc-pass-wd.txt");
  assert.equal(sanitiseFilename("   "), "attachment");
  assert.equal(sanitiseFilename("a".repeat(400)).length, 255);
  assert.ok(!/[\\/\u0000-\u001f]/.test(sanitiseFilename("x\\y/z\u0007.txt")));
});

// ---------- attachments: tenancy and signed downloads ----------

test("a row from another company reads as absent, and cannot be deleted or linked", async () => {
  const { service } = makeService();
  const record = await service.put(COMPANY_A, { filename: "a.png", contentType: "image/png", bytes: PNG });
  assert.equal(await service.get(COMPANY_B, record.id), null);
  assert.equal(await service.readUrl(COMPANY_B, record.id, 60), null);
  assert.equal(await service.delete(COMPANY_B, record.id), false);
  assert.ok(await service.get(COMPANY_A, record.id), "still there for its own company");
});

test("a signed link verifies for its own company only", async () => {
  const { service } = makeService();
  const record = await service.put(COMPANY_A, { filename: "a.png", contentType: "image/png", bytes: PNG });
  const url = new URL(await service.readUrl(COMPANY_A, record.id, 300), "http://local");
  const token = { expires: Number(url.searchParams.get("expires")), signature: url.searchParams.get("sig") };
  assert.equal(await service.verifyDownload(COMPANY_A, record.id, token), true);
  assert.equal(await service.verifyDownload(COMPANY_B, record.id, token), false);
});

test("tampered signatures, altered ids and expired links are refused", async () => {
  const { service, setClock } = makeService();
  const record = await service.put(COMPANY_A, { filename: "a.png", contentType: "image/png", bytes: PNG });
  const url = new URL(await service.readUrl(COMPANY_A, record.id, 120), "http://local");
  const expires = Number(url.searchParams.get("expires"));
  const sig = url.searchParams.get("sig");
  assert.equal(await service.verifyDownload(COMPANY_A, record.id, { expires, signature: `${sig.slice(0, -1)}x` }), false);
  assert.equal(await service.verifyDownload(COMPANY_A, "00000000-0000-4000-8000-000000000000", { expires, signature: sig }), false);
  assert.equal(await service.verifyDownload(COMPANY_A, record.id, { expires: expires + 1, signature: sig }), false);
  setClock(new Date(NOW.getTime() + 121_000));
  assert.equal(await service.verifyDownload(COMPANY_A, record.id, { expires, signature: sig }), false, "expired");
});

test("download TTL is clamped to 15 minutes and to at least one second", async () => {
  const { service } = makeService();
  const record = await service.put(COMPANY_A, { filename: "a.png", contentType: "image/png", bytes: PNG });
  const expiresOf = async (ttl) => Number(new URL(await service.readUrl(COMPANY_A, record.id, ttl), "http://local").searchParams.get("expires"));
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  assert.equal((await expiresOf(99_999)) - nowSeconds, DOWNLOAD_TTL_MAX_SECONDS);
  assert.equal((await expiresOf(0)) - nowSeconds, 1);
});

test("openDownload returns the bytes only with a valid token, and delete removes them", async () => {
  const { service, blobs } = makeService();
  const record = await service.put(COMPANY_A, { filename: "a.png", contentType: "image/png", bytes: PNG });
  const url = new URL(await service.readUrl(COMPANY_A, record.id, 60), "http://local");
  const token = { expires: Number(url.searchParams.get("expires")), signature: url.searchParams.get("sig") };
  const opened = await service.openDownload(COMPANY_A, record.id, token);
  assert.deepEqual(Array.from(opened.bytes), Array.from(PNG));
  assert.equal(await service.openDownload(COMPANY_B, record.id, token), null);
  assert.equal(await service.delete(COMPANY_A, record.id), true);
  assert.equal(await service.get(COMPANY_A, record.id), null);
  assert.equal(blobs.has(record.storageKey), false);
  assert.equal(await service.delete(COMPANY_A, record.id), false);
});

test("the service refuses to start without a long enough signing key, and the error does not echo it", () => {
  const meta = new InMemoryAttachmentMeta();
  const blobs = new InMemoryBlobStore();
  assert.throws(() => new AttachmentService({ meta, blobs, signingKey: "" }), /signing key/);
  assert.throws(() => new AttachmentService({ meta, blobs, signingKey: undefined }), /signing key/);
  try {
    new AttachmentService({ meta, blobs, signingKey: "short-value-xyz" });
    assert.fail("should throw");
  } catch (error) {
    assert.ok(!String(error.message).includes("short-value-xyz"));
  }
});

// ---------- analytics ----------

const conv = (id, companyId, chatbotId, channel, createdAt, connectAgentAt, ticketStatus = "new") => ({
  id, companyId, chatbotId, channel, createdAt: new Date(createdAt), connectAgentAt: connectAgentAt ? new Date(connectAgentAt) : null, ticketStatus,
});
const msg = (id, companyId, conversationId, role, createdAt, isInternalNote = false) => ({
  id, companyId, conversationId, role, isInternalNote, createdAt: new Date(createdAt),
});

const WINDOW = {
  conversations: [
    conv("c1", COMPANY_A, "bot1", "web", "2026-11-02T10:00:00Z", null, "closed"),
    conv("c2", COMPANY_A, "bot1", "web", "2026-11-03T09:00:00Z", "2026-11-03T09:10:00Z"),
    conv("c3", COMPANY_A, "bot2", "whatsapp", "2026-11-03T12:00:00Z", "2026-11-03T13:00:00Z"),
    conv("cb1", COMPANY_B, "bot9", "web", "2026-11-03T09:00:00Z", "2026-11-03T09:05:00Z"),
  ],
  messages: [
    msg("m1", COMPANY_A, "c1", "user", "2026-11-02T10:00:05Z"),
    msg("m2", COMPANY_A, "c2", "user", "2026-11-03T09:01:00Z"),
    msg("m3", COMPANY_A, "c2", "assistant", "2026-11-03T09:02:00Z", true), // internal note, not counted
    msg("m4", COMPANY_A, "c2", "assistant", "2026-11-03T09:12:00Z"),
    msg("m5", COMPANY_A, "c2", "assistant", "2026-11-03T09:20:00Z"),
    msg("m6", COMPANY_A, "c3", "user", "2026-11-03T12:01:00Z"),
    msg("m7", COMPANY_A, "c3", "assistant", "2026-11-03T15:30:00Z"), // 2.5 h after handoff: over the 1 h cut-off
    msg("m8", COMPANY_B, "cb1", "assistant", "2026-11-03T09:06:00Z"),
    msg("m9", COMPANY_B, "c2", "assistant", "2026-11-03T09:13:00Z"), // B's row sitting on A's conversation id: ignored
  ],
  bookingsCreatedAt: [new Date("2026-11-03T10:00:00Z"), new Date("2026-11-20T10:00:00Z")],
};

const source = { calls: [], async load(companyId, from, to) { this.calls.push(companyId); return WINDOW; } };
const analytics = new ChatbotAnalytics(source);
const FROM = new Date("2026-11-01T00:00:00Z");
const TO = new Date("2026-11-08T00:00:00Z");
const ALL = ["conversations", "messages", "handoffs", "resolved_by_ai", "avg_first_response_seconds"];

test("analytics per company: totals and first response come only from that company's rows", async () => {
  const [a] = await analytics.run(COMPANY_A, { metrics: ALL, from: FROM, to: TO, groupBy: null });
  assert.deepEqual(a.values, { conversations: 3, messages: 6, handoffs: 2, resolved_by_ai: 1, avg_first_response_seconds: 120 });
  const [b] = await analytics.run(COMPANY_B, { metrics: ALL, from: FROM, to: TO, groupBy: null });
  assert.deepEqual(b.values, { conversations: 1, messages: 1, handoffs: 1, resolved_by_ai: 0, avg_first_response_seconds: 60 });
  assert.deepEqual(source.calls.slice(-2), [COMPANY_A, COMPANY_B]);
});

test("analytics groups by day, by ISO week and by channel", async () => {
  const byDay = await analytics.run(COMPANY_A, { metrics: ["conversations"], from: FROM, to: TO, groupBy: "day" });
  assert.deepEqual(byDay.map((row) => [row.bucket, row.values.conversations]), [["2026-11-02", 1], ["2026-11-03", 2]]);
  const byWeek = await analytics.run(COMPANY_A, { metrics: ["conversations"], from: FROM, to: TO, groupBy: "week" });
  assert.deepEqual(byWeek.map((row) => [row.bucket, row.values.conversations]), [["2026-11-02", 3]], "2 Nov 2026 is a Monday");
  const byChannel = await analytics.run(COMPANY_A, { metrics: ["conversations", "bookings_created"], from: FROM, to: TO, groupBy: "channel" });
  assert.deepEqual(byChannel.map((row) => [row.bucket, row.values.conversations]), [["web", 2], ["whatsapp", 1]]);
  assert.ok(byChannel.every((row) => !("bookings_created" in row.values)), "bookings have no channel, so they are left out");
});

test("bookings are counted by date, and a single-chatbot filter narrows every count", async () => {
  const [bookings] = await analytics.run(COMPANY_A, { metrics: ["bookings_created"], from: FROM, to: TO, groupBy: null });
  assert.equal(bookings.values.bookings_created, 1);
  const [bot2] = await analytics.run(COMPANY_A, { metrics: ["conversations", "messages", "bookings_created"], from: FROM, to: TO, groupBy: null, chatbotId: "bot2" });
  assert.deepEqual(bot2.values, { conversations: 1, messages: 2 });
});

test("top lists per company are ordered by count, then key", async () => {
  assert.deepEqual(await analytics.topChannels(COMPANY_A, FROM, TO), [{ key: "web", count: 2 }, { key: "whatsapp", count: 1 }]);
  assert.deepEqual(await analytics.topChatbots(COMPANY_A, FROM, TO), [{ key: "bot1", count: 2 }, { key: "bot2", count: 1 }]);
  assert.deepEqual(await analytics.topChatbots(COMPANY_B, FROM, TO), [{ key: "bot9", count: 1 }]);
});

test("analytics rejects bad input before it reads any rows", async () => {
  const before = source.calls.length;
  await expectChatbotError(analytics.run(COMPANY_A, { metrics: ["revenue"], from: FROM, to: TO, groupBy: null }), 400);
  await expectChatbotError(analytics.run(COMPANY_A, { metrics: ["conversations"], from: TO, to: FROM, groupBy: null }), 400);
  await expectChatbotError(analytics.run(COMPANY_A, { metrics: ["conversations"], from: new Date("2024-01-01"), to: TO, groupBy: null }), 400);
  await expectChatbotError(analytics.run("not-a-company", { metrics: ["conversations"], from: FROM, to: TO, groupBy: null }), 403);
  assert.equal(source.calls.length, before);
});

test("summariseWindow ignores rows whose company does not match the query", () => {
  const rows = summariseWindow(COMPANY_A, WINDOW, { metrics: ["conversations"], from: FROM, to: TO, groupBy: null });
  assert.equal(rows[0].values.conversations, 3);
});

// ---------- export ----------

const EXPORT_CONVERSATIONS = [
  { id: "conv-a1", companyId: COMPANY_A, chatbotId: "bot1" },
  { id: "conv-b1", companyId: COMPANY_B, chatbotId: "bot9" },
];
const EXPORT_MESSAGES = [
  { id: "e2", companyId: COMPANY_A, conversationId: "conv-a1", role: "assistant", message: "Hi there", mediaUrl: null, mediaName: null, isInternalNote: false, createdAt: new Date("2026-11-02T10:02:00Z") },
  { id: "e1", companyId: COMPANY_A, conversationId: "conv-a1", role: "user", message: "=HYPERLINK(x)", mediaUrl: null, mediaName: null, isInternalNote: false, createdAt: new Date("2026-11-02T10:00:00Z") },
  { id: "e3", companyId: COMPANY_A, conversationId: "conv-a1", role: "assistant", message: "INTERNAL-ONLY", mediaUrl: null, mediaName: null, isInternalNote: true, createdAt: new Date("2026-11-02T10:01:00Z") },
  { id: "e4", companyId: COMPANY_B, conversationId: "conv-a1", role: "user", message: "LEAK-B", mediaUrl: null, mediaName: null, isInternalNote: false, createdAt: new Date("2026-11-02T10:01:30Z") },
  { id: "e5", companyId: COMPANY_B, conversationId: "conv-b1", role: "user", message: "B-ONLY", mediaUrl: null, mediaName: null, isInternalNote: false, createdAt: new Date("2026-11-02T10:00:00Z") },
];
// A deliberately careless reader: it returns rows for the conversation id from every company.
const exportReader = {
  async findConversation(companyId, id) { return EXPORT_CONVERSATIONS.find((row) => row.id === id) ?? null; },
  async chatbotTitle(companyId, chatbotId) { return chatbotId === "bot1" ? "Bot A" : null; },
  async listMessages(companyId, id) { return EXPORT_MESSAGES.filter((row) => row.conversationId === id); },
};

test("JSON export contains only the company's visible rows, oldest first", async () => {
  const result = await exportConversation(exportReader, COMPANY_A, "conv-a1", "json", NOW);
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/json");
  assert.equal(result.fileName, "conversation-conv-a1.json");
  const data = JSON.parse(result.body);
  assert.equal(data.chatbot, "Bot A");
  assert.deepEqual(data.messages.map((row) => row.message), ["=HYPERLINK(x)", "Hi there"]);
  assert.ok(!result.body.includes("LEAK-B"));
  assert.ok(!result.body.includes("INTERNAL-ONLY"));
});

test("CSV export guards spreadsheet formulas and carries only the company's rows", async () => {
  const result = await exportConversation(exportReader, COMPANY_A, "conv-a1", "csv", NOW);
  assert.equal(result.contentType, "text/csv");
  assert.ok(result.body.startsWith("Timestamp,Role,Message\n"));
  assert.ok(result.body.includes("'=HYPERLINK(x)"));
  assert.ok(!result.body.includes("LEAK-B"));
  assert.ok(!result.body.includes("INTERNAL-ONLY"));
});

test("TXT is the default for an unknown format, and PDF answers 501", async () => {
  const txt = await exportConversation(exportReader, COMPANY_A, "conv-a1", "docx", NOW);
  assert.equal(txt.contentType, "text/plain");
  assert.ok(txt.body.includes("[2026-11-02 10:00:00] [USER] =HYPERLINK(x)"));
  const pdf = await exportConversation(exportReader, COMPANY_A, "conv-a1", "pdf", NOW);
  assert.equal(pdf.status, 501);
  assert.equal(pdf.error, "not_implemented");
});

test("a conversation from another company is reported as not found, in every format", async () => {
  for (const format of ["json", "csv", "txt"]) {
    const result = await exportConversation(exportReader, COMPANY_A, "conv-b1", format, NOW);
    assert.equal(result.status, 404, format);
  }
  await expectChatbotError(exportConversation(exportReader, "not-a-company", "conv-a1", "json", NOW), 403);
});

test("export file names use only safe characters from the conversation id", () => {
  assert.equal(safeFileStem('conv"; rm -rf'), "conv___rm_-rf");
  const file = renderExport("json", { conversationId: 'x"\r\n', chatbotTitle: null, messages: [], now: NOW });
  assert.match(file.fileName, /^conversation-[A-Za-z0-9_-]+\.json$/);
});

// ---------- health and metrics ----------

const PROBES_OK = {
  async ping() {},
  async hasTable() { return true; },
  async hasColumn() { return true; },
};

function collectKeys(value, out = []) {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

test("health report is ok when the database, runtime, tables and columns are all present", async () => {
  const report = await buildHealthReport({ probes: PROBES_OK, runtimeEnabled: true, version: "1.0.0", now: NOW });
  assert.equal(report.ok, true);
  assert.equal(report.extension, "chatbot");
  assert.equal(report.timestamp, NOW.toISOString());
  assert.ok(Object.values(report.checks.tables).every(Boolean));
});

test("health report has no key or token, even with a signing key in the same process and a leaky database error", async () => {
  new AttachmentService({ meta: new InMemoryAttachmentMeta(), blobs: new InMemoryBlobStore(), signingKey: SIGNING_KEY });
  const leaky = {
    ...PROBES_OK,
    async ping() {
      throw new Error("connect failed: postgres://app:hunter2@db.internal:5432/titan?sslpassword=hunter2");
    },
  };
  const report = await buildHealthReport({ probes: leaky, runtimeEnabled: true, version: "1.0.0", now: NOW });
  const text = JSON.stringify(report);
  assert.equal(report.ok, false);
  assert.equal(report.checks.error, "database_unreachable");
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("postgres://"));
  assert.ok(!text.includes(SIGNING_KEY));
  for (const key of collectKeys(report)) {
    assert.ok(!/key|token|secret|password|dsn/i.test(key) || key === "checks" || key === "runtime_enabled", `unexpected key: ${key}`);
  }
});

test("health report is not ok when a table is missing or the runtime is disabled", async () => {
  const noTable = { ...PROBES_OK, async hasTable(name) { return name !== "chatbot_attachments"; } };
  const missing = await buildHealthReport({ probes: noTable, runtimeEnabled: true, version: "1.0.0", now: NOW });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.tables.chatbot_attachments, false);
  const off = await buildHealthReport({ probes: PROBES_OK, runtimeEnabled: false, version: "1.0.0", now: NOW });
  assert.equal(off.ok, false);
  const badVersion = await buildHealthReport({ probes: PROBES_OK, runtimeEnabled: true, version: "1.0.0 <script>", now: NOW });
  assert.equal(badVersion.version, "unknown");
});

test("metrics keep only allow-listed tags and drop anything that looks like a secret", () => {
  const registry = new MetricsRegistry();
  registry.increment("chatbot.attachment.rejected", { outcome: "type_not_allowed" });
  registry.increment("chatbot.attachment.rejected", { outcome: "type_not_allowed", user_email: "jason@example.com" });
  registry.increment("chatbot.export.run", { format: "Bearer abc.def" });
  registry.increment("not-namespaced", { outcome: "ok" });
  registry.timing("chatbot.export.duration", 12.5, { format: "json" });
  registry.timing("chatbot.export.duration", 7.5, { format: "json" });
  const snapshot = registry.snapshot();
  assert.equal(snapshot.counters["chatbot.attachment.rejected{outcome=type_not_allowed}"], 2);
  assert.equal(snapshot.counters["chatbot.export.run"], 1);
  assert.equal(snapshot.counters["not-namespaced"], undefined);
  assert.deepEqual(snapshot.timings["chatbot.export.duration{format=json}"], { count: 2, sum: 20, max: 12.5 });
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes("jason@example.com"));
  assert.ok(!text.includes("Bearer"));
});

// ---------- Drizzle builders: company_id on every statement ----------

function assertScoped(query, companyId, label) {
  const { sql, params } = render(query);
  assert.ok(sql.includes('"company_id"'), `${label}: references company_id`);
  assert.ok(params.includes(companyId), `${label}: binds the company id`);
  if (!/^\s*insert/i.test(sql)) {
    assert.match(sql, /"company_id" = \$\d+/, `${label}: has a company_id equality predicate`);
  }
  return { sql, params };
}

const RECORD = {
  id: FIXED_ID, companyId: COMPANY_A, filename: "a.png", contentType: "image/png", sizeBytes: 12,
  sha256: "a".repeat(64), storageKey: `chatbot/attachments/${COMPANY_A}/${FIXED_ID}`, createdAt: NOW,
};

test("every attachment builder filters on company_id, and live rows only where it reads", () => {
  assertScoped(buildInsertAttachment(db, COMPANY_A, RECORD), COMPANY_A, "insert attachment");
  const find = assertScoped(buildFindAttachment(db, COMPANY_A, FIXED_ID), COMPANY_A, "find attachment");
  assert.match(find.sql, /"deleted_at" is null/i);
  assertScoped(buildMarkAttachmentDeleted(db, COMPANY_A, FIXED_ID, NOW), COMPANY_A, "soft delete attachment");
  assert.throws(() => buildFindAttachment(db, "not-a-company", FIXED_ID), (error) => error.status === 403);
});

test("every analytics and export builder filters on company_id", () => {
  assertScoped(buildLoadConversationsWindow(db, COMPANY_A, FROM, TO), COMPANY_A, "analytics conversations");
  assertScoped(buildLoadMessagesWindow(db, COMPANY_A, FROM, TO), COMPANY_A, "analytics messages");
  assertScoped(buildFindExportConversation(db, COMPANY_A, "conv-a1"), COMPANY_A, "export find conversation");
  assertScoped(buildChatbotTitle(db, COMPANY_A, "bot1"), COMPANY_A, "export chatbot title");
  const messages = assertScoped(buildListExportMessages(db, COMPANY_A, "conv-a1"), COMPANY_A, "export messages");
  assert.match(messages.sql, /"is_internal_note" = \$\d+/, "internal notes are excluded in SQL");
  assert.ok(messages.params.includes(false));
});
