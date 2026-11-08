// Knowledge base tests (node:test). No network, no provider keys, no database.
// Providers and HTTP are fakes. Storage runs in memory for behaviour, and the Drizzle storage is checked by
// recording the statements it sends and by rendering its query builders with PgDialect.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-knowledge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import * as k from "../../server/modules/chatbot/knowledge/index.ts";
import {
  DrizzleKnowledgeStorage,
  mapKnowledgeDatabaseError,
} from "../../server/modules/chatbot/knowledge/drizzle-storage.ts";
import {
  chatbotKnowledgeChunks,
  chatbotKnowledgeEmbeddings,
  chatbotKnowledgeSources,
  KNOWLEDGE_CONSTRAINTS,
} from "../../server/modules/chatbot/db/knowledge.ts";
import { CONTRACT_FLAGS, readFlag } from "../../server/modules/chatbot/contracts/index.ts";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHATBOT = "chatbot-1";
const MODEL = { provider: "openai", model: "text-embedding-3-small", dimensions: 3 };
const ON = { [CONTRACT_FLAGS.KNOWLEDGE_ENABLED]: "true" };
const dialect = new PgDialect();

/** Deterministic toy embedding: one axis per topic, so ranking is easy to predict. */
function toyVector(text) {
  const t = text.toLowerCase();
  return [t.includes("refund") ? 1 : 0, t.includes("shipping") ? 1 : 0, 0.1];
}

/** Fake ModelProvider. Records every embed call. Never reaches the network. */
function fakeProvider({ dimensions = MODEL.dimensions, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    key: "openai",
    async complete() {
      throw new Error("not used");
    },
    async *stream() {
      throw new Error("not used");
    },
    async embed(companyId, request) {
      calls.push({ companyId, inputs: [...request.inputs], timeoutMs: request.timeoutMs });
      if (fail) throw fail;
      return {
        provider: "openai",
        model: request.model,
        dimensions,
        vectors: request.inputs.map((text) => (dimensions === 3 ? toyVector(text) : new Array(dimensions).fill(0.5))),
        usage: { inputTokens: 1 },
      };
    },
  };
}

/** Fake HttpClient. Serves a fixed table of URLs and records every call. */
function fakeHttp(routes) {
  const calls = [];
  const http = async (request) => {
    calls.push(request);
    assert.ok(Number.isInteger(request.timeoutMs) && request.timeoutMs > 0, "every request has a timeout");
    const route = routes[request.url];
    if (!route) throw Object.assign(new Error("no route"), { kind: "network", message: "no route" });
    if (route instanceof Error) throw route;
    return { status: route.status ?? 200, headers: route.headers ?? { "content-type": "text/html" }, body: route.body ?? "" };
  };
  return { http, calls };
}

const PUBLIC_RESOLVER = async () => ["93.184.216.34"];

function indexer(storage, provider, extra = {}) {
  return new k.KnowledgeIndexer({
    storage,
    provider,
    embeddingModel: MODEL,
    env: ON,
    http: fakeHttp({}).http,
    resolve: PUBLIC_RESOLVER,
    timeoutMs: 5000,
    ...extra,
  });
}

function retriever(storage, provider, env = ON) {
  return new k.KnowledgeRetriever({
    reader: storage,
    providerFor: (key) => (key === provider.key ? provider : null),
    env,
  });
}

function query(companyId, text, extra = {}) {
  return { companyId, chatbotId: CHATBOT, text, topK: 5, minScore: -1, embeddingModel: MODEL, timeoutMs: 5000, ...extra };
}

// ---------------------------------------------------------------- chunking

test("chunkText keeps paragraphs together when they fit and never exceeds the limit", () => {
  const chunks = k.chunkText("Alpha one.\n\nBeta two.\n\nGamma three.", 512);
  assert.deepEqual(chunks, ["Alpha one.\n\nBeta two.\n\nGamma three."]);

  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const pieces = k.chunkText(long, 20);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(k.approxTokenCount(piece) <= 20, `chunk too long: ${piece.length}`);
    assert.ok(piece.trim().length > 0, "no empty chunks");
  }
  assert.equal(pieces.join(" ").replace(/\s+/g, " ").trim(), long.replace(/\s+/g, " ").trim(), "no text lost");
});

test("chunkText cuts a single run longer than the limit into pieces", () => {
  const url = "https://example.com/" + "a".repeat(300);
  const pieces = k.chunkText(url, 16);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((p) => p.length <= 16 * k.CHARS_PER_TOKEN));
  assert.equal(pieces.join(""), url);
});

test("chunkText returns nothing for blank input and rejects a bad limit", () => {
  assert.deepEqual(k.chunkText("   \n\n  "), []);
  assert.throws(() => k.chunkText("x", 0), RangeError);
});

test("chunk ids are deterministic and change with the position and the text", () => {
  const a = k.chunkIdFor("src-1", 0, "hash-a");
  assert.equal(a, k.chunkIdFor("src-1", 0, "hash-a"));
  assert.notEqual(a, k.chunkIdFor("src-1", 1, "hash-a"));
  assert.notEqual(a, k.chunkIdFor("src-1", 0, "hash-b"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("Q&A text keeps the PHP form question : answer", () => {
  assert.equal(k.qaText(" Do you deliver? ", " Yes, daily. "), "Do you deliver? : Yes, daily.");
});

// ---------------------------------------------------------------- cosine and ranking

test("cosineSimilarity scores identical, orthogonal and opposite vectors", () => {
  assert.equal(k.cosineSimilarity([1, 2, 3], [1, 2, 3]).toFixed(6), "1.000000");
  assert.equal(k.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(k.cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(k.cosineSimilarity([0, 0], [1, 1]), 0, "zero vector scores 0 as in the PHP");
  assert.throws(() => k.cosineSimilarity([1, 2], [1, 2, 3]), RangeError, "mismatched lengths never compare");
});

test("retrieval ranks by cosine score, applies topK and minScore, and breaks ties stably", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  const idx = indexer(storage, provider);
  await idx.addText(COMPANY_A, CHATBOT, { title: "Refunds", content: "Refunds are paid within five days." });
  await idx.addText(COMPANY_A, CHATBOT, { title: "Shipping", content: "Shipping takes two days." });
  await idx.addText(COMPANY_A, CHATBOT, { title: "Both", content: "Refund shipping costs are covered." });
  await idx.addText(COMPANY_A, CHATBOT, { title: "Neither", content: "Opening hours are nine to five." });

  const r = retriever(storage, provider);
  const hits = await r.retrieve(query(COMPANY_A, "refund please", { topK: 5, minScore: 0.2 }));
  assert.deepEqual(hits.map((h) => h.sourceTitle), ["Refunds", "Both"]);
  assert.ok(hits[0].score >= hits[1].score);
  assert.ok(hits.every((h) => h.score >= 0.2));

  const top1 = await r.retrieve(query(COMPANY_A, "refund please", { topK: 1, minScore: -1 }));
  assert.equal(top1.length, 1);
  assert.equal(top1[0].sourceTitle, "Refunds");

  const none = await r.retrieve(query(COMPANY_A, "refund", { topK: 5, minScore: 0.99 }));
  assert.ok(none.every((h) => h.score >= 0.99));
});

test("retrieval returns nothing when the flag is off, and rejects an out-of-range topK", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  await indexer(storage, provider).addText(COMPANY_A, CHATBOT, { title: "t", content: "refund" });
  assert.deepEqual(await retriever(storage, provider, {}).retrieve(query(COMPANY_A, "refund")), []);
  await assert.rejects(
    retriever(storage, provider).retrieve(query(COMPANY_A, "refund", { topK: 0 })),
    (e) => e.code === "invalid_input",
  );
});

// ---------------------------------------------------------------- tenancy

test("retrieval never returns another company's chunks, even with the same chatbot id", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  const a = await indexer(storage, provider).addText(COMPANY_A, CHATBOT, { title: "A refunds", content: "refund policy A" });
  const b = await indexer(storage, provider).addText(COMPANY_B, CHATBOT, { title: "B refunds", content: "refund policy B" });

  const hitsA = await retriever(storage, provider).retrieve(query(COMPANY_A, "refund"));
  assert.ok(hitsA.length >= 1);
  assert.ok(hitsA.every((h) => h.sourceId === a.id), "company A sees only its source");

  const hitsB = await retriever(storage, provider).retrieve(query(COMPANY_B, "refund"));
  assert.ok(hitsB.every((h) => h.sourceId === b.id), "company B sees only its source");

  const otherCompany = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(await retriever(storage, provider).retrieve(query(otherCompany, "refund")), []);
  assert.equal(await storage.getSource(COMPANY_B, a.id), null, "A's source is absent for B");
  assert.equal(await storage.deleteSource(COMPANY_B, a.id), false, "B cannot delete A's source");
  assert.ok(await storage.getSource(COMPANY_A, a.id), "A's source survives B's delete attempt");
});

test("retrieval refuses a missing or malformed company id", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  await assert.rejects(retriever(storage, provider).retrieve(query("", "refund")), /Company scope required|403/);
  await assert.rejects(retriever(storage, provider).retrieve(query("not-a-uuid", "refund")), /Company scope required|403/);
  assert.equal(provider.calls.length, 0, "no embedding call without a tenant");
});

// ---------------------------------------------------------------- indexing and deletion

test("deleting a source removes its chunks and embeddings and no longer retrieves them", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  const idx = indexer(storage, provider);
  const source = await idx.addText(COMPANY_A, CHATBOT, { title: "Refunds", content: "refund in five days" });
  const other = await idx.addText(COMPANY_A, CHATBOT, { title: "Shipping", content: "shipping in two days" });
  assert.equal(source.status, "ready");

  const before = await retriever(storage, provider).retrieve(query(COMPANY_A, "refund"));
  assert.ok(before.some((h) => h.sourceId === source.id));

  assert.equal(await idx.deleteSource(COMPANY_A, source.id), true);
  assert.equal(await storage.getSource(COMPANY_A, source.id), null);
  const after = await retriever(storage, provider).retrieve(query(COMPANY_A, "refund"));
  assert.ok(after.every((h) => h.sourceId !== source.id), "no chunk of the deleted source is returned");
  const otherHits = await retriever(storage, provider).retrieve(query(COMPANY_A, "shipping"));
  assert.ok(otherHits.some((h) => h.sourceId === other.id), "other sources are untouched");
  assert.equal(await idx.deleteSource(COMPANY_A, source.id), false, "second delete finds nothing");
});

test("re-indexing unchanged content skips the embedding call", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  const pageHtml = "<html><head><title>Hours</title></head><body><p>Open nine to five.</p></body></html>";
  const { http } = fakeHttp({ "https://example.com/": { body: pageHtml } });
  const idx = indexer(storage, provider, { http });

  const first = await idx.addUrl(COMPANY_A, CHATBOT, { url: "https://example.com/", single: true });
  const second = await idx.addUrl(COMPANY_A, CHATBOT, { url: "https://example.com/", single: true });
  assert.equal(first.length, 1);
  assert.equal(second[0].id, first[0].id, "same source is reused by uri");
  assert.equal(provider.calls.length, 1, "unchanged content is not embedded again");
});

test("an embedding failure records a redacted error and keeps the source out of retrieval", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider({ fail: new Error("bad key sk-abcdef123456789 for request") });
  const source = await indexer(storage, provider).addText(COMPANY_A, CHATBOT, { title: "t", content: "refund" });
  assert.equal(source.status, "failed");
  assert.match(source.lastError, /\[redacted\]/);
  assert.doesNotMatch(source.lastError, /sk-abcdef/);
  assert.deepEqual(await retriever(storage, fakeProvider()).retrieve(query(COMPANY_A, "refund")), []);
});

test("a dimension mismatch from the provider is rejected before anything is stored", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider({ dimensions: 5 });
  const source = await indexer(storage, provider).addText(COMPANY_A, CHATBOT, { title: "t", content: "refund" });
  assert.equal(source.status, "failed");
  assert.match(source.lastError, /configured model/);
  assert.equal((await storage.listCandidates(COMPANY_A, CHATBOT, MODEL)).length, 0);
});

test("with the knowledge flag off, indexing is refused; only the exact value 'true' turns it on", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  for (const value of ["1", "yes", "on", "TRUE", undefined]) {
    const env = value === undefined ? {} : { [CONTRACT_FLAGS.KNOWLEDGE_ENABLED]: value };
    await assert.rejects(
      indexer(storage, provider, { env }).addText(COMPANY_A, CHATBOT, { title: "t", content: "x" }),
      (e) => e.code === "disabled",
    );
  }
  assert.equal(readFlag(CONTRACT_FLAGS.KNOWLEDGE_ENABLED, ON), true);
  assert.equal(provider.calls.length, 0);
});

test("article import reads article records as faq sources and never writes articles", async () => {
  const storage = k.createMemoryKnowledgeStorage();
  const provider = fakeProvider();
  const articles = [{ id: "a1", title: "Refund policy", content: "<p>Refunds in <b>five</b> days.</p>" }];
  const [source] = await indexer(storage, provider).importArticles(COMPANY_A, CHATBOT, articles);
  assert.equal(source.kind, "faq");
  assert.equal(source.uri, "article:a1");
  assert.match(provider.calls[0].inputs[0], /Refunds in five days\./);
  assert.equal(articles[0].content, "<p>Refunds in <b>five</b> days.</p>", "input is not mutated");
});

// ---------------------------------------------------------------- SSRF guard

const REFUSED_URLS = [
  "http://127.0.0.1/",
  "http://127.0.0.1:80/admin",
  "http://10.0.0.5/",
  "http://169.254.169.254/latest/meta-data/",
  "http://172.16.4.2/",
  "http://192.168.1.1/",
  "http://0.0.0.0/",
  "http://100.64.0.1/",
  "http://0x7f000001/", // WHATWG parsing turns this into 127.0.0.1
  "http://2130706433/", // decimal form of 127.0.0.1
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[fe80::1]/",
  "http://[fd00::1]/",
  "http://localhost/",
  "http://app.localhost/",
  "http://intranet/",
  "http://printer.local/",
  "file:///etc/passwd",
  "ftp://example.com/file",
  "gopher://example.com/",
  "data:text/html,hi",
  "http://user:pass@example.com/",
  "http://example.com:8080/",
  "not a url",
];

for (const raw of REFUSED_URLS) {
  test(`SSRF guard refuses ${raw}`, async () => {
    let resolverCalls = 0;
    await assert.rejects(
      k.assertPublicHttpUrl(raw, async () => {
        resolverCalls++;
        return ["93.184.216.34"];
      }),
      (e) => e instanceof k.UrlRefusedError,
    );
    assert.equal(resolverCalls, 0, "a literal refusal never reaches DNS");
  });
}

test("SSRF guard refuses a public-looking name that resolves to a private address", async () => {
  await assert.rejects(
    k.assertPublicHttpUrl("https://shop.example.com/", async () => ["10.1.2.3"]),
    (e) => e.reason === "address",
  );
  await assert.rejects(
    k.assertPublicHttpUrl("https://shop.example.com/", async () => ["93.184.216.34", "169.254.169.254"]),
    (e) => e.reason === "address",
    "one private address among public ones is enough to refuse",
  );
  await assert.rejects(k.assertPublicHttpUrl("https://nowhere.example.com/", async () => []), (e) => e.reason === "resolution");
});

test("SSRF guard accepts a public https URL and the standard ports", async () => {
  const url = await k.assertPublicHttpUrl("https://example.com:443/about", PUBLIC_RESOLVER);
  assert.equal(url.hostname, "example.com");
  await k.assertPublicHttpUrl("http://example.com/", PUBLIC_RESOLVER);
});

test("address checks cover the edge ranges", () => {
  assert.equal(k.isPrivateIPv4("8.8.8.8"), false);
  assert.equal(k.isPrivateIPv4("172.32.0.1"), false, "172.32 is outside 172.16/12");
  assert.equal(k.isPrivateIPv4("100.128.0.1"), false, "100.128 is outside the CGNAT range");
  assert.equal(k.isPrivateIPv4("999.1.1.1"), true, "malformed is treated as blocked");
  assert.equal(k.isPrivateIPv6("2606:4700:4700::1111"), false);
  assert.equal(k.isPrivateIPv6("::ffff:8.8.8.8"), false);
  assert.equal(k.isPrivateIPv6("zz::1"), true, "unparseable is treated as blocked");
});

test("fetch refuses a redirect to a private address and never requests it", async () => {
  const { http, calls } = fakeHttp({
    "https://example.com/": { status: 302, headers: { location: "http://127.0.0.1/admin" } },
  });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 }),
    (e) => e.code === "url_refused",
  );
  assert.equal(calls.length, 1, "only the public hop was requested");
});

test("fetch maps transport timeouts and bad statuses to KnowledgeError without the raw message", async () => {
  const timeoutHttp = async () => {
    throw Object.assign(new Error("socket hang up with secret-token-abcdef12"), { kind: "timeout" });
  };
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: timeoutHttp, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 }),
    (e) => e.code === "fetch_failed" && /timed out/.test(e.message),
  );
  const { http } = fakeHttp({ "https://example.com/": { status: 500 } });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 }),
    (e) => e.code === "fetch_failed" && /500/.test(e.message),
  );
});

test("fetch refuses non-text content and oversized bodies", async () => {
  const { http: binary } = fakeHttp({
    "https://example.com/a.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF" },
  });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/a.pdf", { http: binary, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 }),
    (e) => e.code === "unsupported_content",
  );
  const { http: big } = fakeHttp({ "https://example.com/": { body: "x".repeat(2000) } });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: big, resolve: PUBLIC_RESOLVER, timeoutMs: 1000, maxBytes: 1000 }),
    (e) => e.code === "too_large",
  );
});

test("crawl stays on the same host, skips images and cdn paths, and respects maxPages", async () => {
  const home = `<html><head><title>Home</title></head><body>
    <a href="/a">A</a><a href='/b.png'>img</a><a href="https://other.com/x">x</a>
    <a href="/a">dup</a><a href="#top">top</a><a href="/cdn-cgi/l/email">mail</a><a href="/c">C</a>
    </body></html>`;
  const { http, calls } = fakeHttp({
    "https://example.com/": { body: home },
    "https://example.com/a": { body: "<title>A page</title><p>Alpha text.</p>" },
    "https://example.com/c": { body: "<title>C page</title><p>Gamma text.</p>" },
  });
  const pages = await k.crawlSite("https://example.com/", { http, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 });
  assert.deepEqual(pages.map((p) => p.url), ["https://example.com/", "https://example.com/a", "https://example.com/c"]);
  assert.equal(pages[1].title, "A page");
  assert.ok(!calls.some((c) => c.url.includes("other.com")));

  const capped = await k.crawlSite("https://example.com/", { http, resolve: PUBLIC_RESOLVER, timeoutMs: 1000, maxPages: 2 });
  assert.equal(capped.length, 2);

  const single = await k.crawlSite("https://example.com/", { http, resolve: PUBLIC_RESOLVER, timeoutMs: 1000, single: true });
  assert.equal(single.length, 1);
});

test("crawl fails when the start page fails, and skips a broken linked page", async () => {
  const { http: down } = fakeHttp({});
  await assert.rejects(k.crawlSite("https://example.com/", { http: down, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 }));

  const { http } = fakeHttp({
    "https://example.com/": { body: '<a href="/broken">x</a><a href="/ok">y</a>' },
    "https://example.com/ok": { body: "<p>fine</p>" },
  });
  const pages = await k.crawlSite("https://example.com/", { http, resolve: PUBLIC_RESOLVER, timeoutMs: 1000 });
  assert.deepEqual(pages.map((p) => p.url), ["https://example.com/", "https://example.com/ok"]);
});

test("htmlToText drops scripts, headers and footers, and decodes entities", () => {
  const text = k.htmlToText(
    "<header>Menu</header><script>var x=1</script><p>Tom &amp; Jerry &#39;s &lt;3&gt;</p><footer>Copy</footer><p>End</p>",
  );
  assert.equal(text, "Tom & Jerry 's <3>\n\nEnd", "paragraphs are separated by a blank line");
});

test("embedInputs batches large inputs and keeps them in order", async () => {
  const provider = fakeProvider();
  const inputs = Array.from({ length: 200 }, (_, i) => `refund ${i}`);
  const vectors = await k.embedInputs(provider, COMPANY_A, MODEL, inputs, 1000);
  assert.equal(vectors.length, 200);
  assert.deepEqual(provider.calls.map((c) => c.inputs.length), [96, 96, 8]);
  assert.deepEqual(vectors[199], toyVector("refund 199"));
});

// ---------------------------------------------------------------- Drizzle storage (SQL only)

/** Records every statement Drizzle sends. Returns the rows from `rowsFor`. No socket is opened. */
function recordingDb(rowsFor = () => []) {
  const statements = [];
  const events = [];
  const client = {
    async query(config, values) {
      const text = typeof config === "string" ? config : config.text;
      const params = typeof config === "string" ? (values ?? []) : (config.values ?? values ?? []);
      statements.push({ text, params });
      events.push("query");
      return { rows: rowsFor(text), rowCount: 0, fields: [] };
    },
  };
  const db = drizzle(client);
  const wrapped = {
    insert: (...a) => db.insert(...a),
    select: (...a) => db.select(...a),
    update: (...a) => db.update(...a),
    delete: (...a) => db.delete(...a),
    async transaction(fn) {
      events.push("begin");
      try {
        const result = await fn(db);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
  return { db: wrapped, statements, events };
}

function render(query) {
  return dialect.sqlToQuery(query.getSQL());
}

test("every Drizzle table carries company_id and the composite keys include it", () => {
  for (const table of [chatbotKnowledgeSources, chatbotKnowledgeChunks, chatbotKnowledgeEmbeddings]) {
    const cfg = getTableConfig(table);
    assert.ok(cfg.columns.some((c) => c.name === "company_id" && c.notNull), `${cfg.name} has company_id`);
    assert.ok(cfg.primaryKeys.length >= 1 && cfg.primaryKeys[0].columns[0].name === "company_id", `${cfg.name} pk starts with company_id`);
  }
  const uri = getTableConfig(chatbotKnowledgeSources).indexes.find((i) => i.config.name === KNOWLEDGE_CONSTRAINTS.sourceUri);
  assert.deepEqual(uri.config.columns.map((c) => c.name), ["company_id", "chatbot_id", "kind", "uri"]);
  const ordinal = getTableConfig(chatbotKnowledgeChunks).indexes.find((i) => i.config.name === KNOWLEDGE_CONSTRAINTS.chunkOrdinal);
  assert.equal(ordinal.config.columns[0].name, "company_id");
  const chunkFks = getTableConfig(chatbotKnowledgeChunks).foreignKeys;
  assert.ok(chunkFks.some((fk) => fk.onDelete === "cascade"), "chunks cascade with their source");
});

test("Drizzle storage: each statement it sends is filtered by company_id", async () => {
  const { db, statements } = recordingDb((text) =>
    /insert into "chatbot_knowledge_sources"/i.test(text) || (/from "chatbot_knowledge_sources"/i.test(text) && /"id" = /i.test(text))
      ? [sourceRowArray()]
      : [],
  );
  const storage = new DrizzleKnowledgeStorage(db);
  await storage.insertSource(COMPANY_A, { chatbotId: CHATBOT, kind: "text", title: "t", uri: null });
  await storage.getSource(COMPANY_A, "src-1");
  await storage.listSources(COMPANY_A, CHATBOT);
  await storage.setSourceStatus(COMPANY_A, "src-1", "ready", { contentHash: "h", lastError: null, lastIndexedAt: new Date() });
  await storage.listCandidates(COMPANY_A, CHATBOT, MODEL, ["src-1"]);
  await storage.deleteSource(COMPANY_A, "src-1");

  assert.ok(statements.length >= 6);
  for (const s of statements) {
    assert.ok(s.params.includes(COMPANY_A), `company id missing from: ${s.text}`);
    assert.ok(!s.params.includes(COMPANY_B));
  }
});

test("Drizzle storage: deleteSource removes embeddings, then chunks, then the source, in one transaction", async () => {
  const { db, statements, events } = recordingDb((text) =>
    /select "id" from "chatbot_knowledge_chunks"/i.test(text) ? [["c1"]] : /delete from "chatbot_knowledge_sources"/i.test(text) ? [["src-1"]] : [],
  );
  const storage = new DrizzleKnowledgeStorage(db);
  assert.equal(await storage.deleteSource(COMPANY_A, "src-1"), true);
  assert.deepEqual(events.filter((e) => e !== "query"), ["begin", "commit"]);

  const deletes = statements.filter((s) => /^\s*delete/i.test(s.text)).map((s) => s.text);
  assert.equal(deletes.length, 3);
  assert.match(deletes[0], /delete from "chatbot_knowledge_embeddings"/i);
  assert.match(deletes[1], /delete from "chatbot_knowledge_chunks"/i);
  assert.match(deletes[2], /delete from "chatbot_knowledge_sources"/i);
});

test("Drizzle storage: replaceChunks rolls back when a write fails", async () => {
  let failInsert = false;
  const { db, events } = recordingDb((text) => {
    if (/from "chatbot_knowledge_sources"/i.test(text)) return [[CHATBOT]];
    if (/insert into "chatbot_knowledge_chunks"/i.test(text) && failInsert) throw new Error("boom");
    return [];
  });
  const storage = new DrizzleKnowledgeStorage(db);
  failInsert = true;
  await assert.rejects(
    storage.replaceChunks(
      COMPANY_A,
      "src-1",
      [{ companyId: COMPANY_A, sourceId: "src-1", chatbotId: CHATBOT, ordinal: 0, text: "x", tokenCount: 1, contentHash: "h", metadata: null }],
      [],
    ),
    /Failed query: insert into "chatbot_knowledge_chunks"/,
  );
  assert.ok(events.includes("rollback"));
  assert.ok(!events.includes("commit"));
});

test("Drizzle storage: replaceChunks refuses a chunk from another company before writing", async () => {
  const { db, statements } = recordingDb((text) => (/from "chatbot_knowledge_sources"/i.test(text) ? [[CHATBOT]] : []));
  const storage = new DrizzleKnowledgeStorage(db);
  await assert.rejects(
    storage.replaceChunks(
      COMPANY_A,
      "src-1",
      [{ companyId: COMPANY_B, sourceId: "src-1", chatbotId: CHATBOT, ordinal: 0, text: "x", tokenCount: 1, contentHash: "h", metadata: null }],
      [],
    ),
    (e) => e.code === "write_failed",
  );
  assert.ok(!statements.some((s) => /^\s*(insert|delete)/i.test(s.text)), "no write was attempted");
});

test("Drizzle retrieval query joins on company_id and filters on ready status and the exact model", async () => {
  const captured = recordingDb();
  await new DrizzleKnowledgeStorage(captured.db).listCandidates(COMPANY_A, CHATBOT, MODEL, ["src-1"]);
  const sql = captured.statements.at(-1);
  assert.match(sql.text, /"chatbot_knowledge_embeddings"\."company_id" = \$1/);
  assert.match(sql.text, /"chatbot_knowledge_chunks"\."company_id" = "chatbot_knowledge_embeddings"\."company_id"/);
  assert.match(sql.text, /"chatbot_knowledge_sources"\."company_id" = "chatbot_knowledge_chunks"\."company_id"/);
  assert.match(sql.text, /"chatbot_knowledge_sources"\."status" = \$/);
  assert.ok(sql.params.includes("ready"));
  assert.ok(sql.params.includes("text-embedding-3-small"));
  assert.ok(sql.params.includes(3));
  assert.ok(sql.params.includes(COMPANY_A));
});

test("Drizzle storage maps the source uri unique violation to a conflict", () => {
  const dup = Object.assign(new Error("duplicate"), { code: "23505", constraint: KNOWLEDGE_CONSTRAINTS.sourceUri });
  const mapped = mapKnowledgeDatabaseError(dup);
  assert.equal(mapped.code, "conflict");
  assert.equal(mapped.status, 409);
  const other = Object.assign(new Error("other"), { code: "23505", constraint: "something_else" });
  assert.equal(mapKnowledgeDatabaseError(other), other);
});

/** Array-mode row in the column order of chatbotKnowledgeSources, as Drizzle's node-postgres session reads it. */
function sourceRowArray() {
  const r = sourceRow();
  return [r.companyId, r.id, r.chatbotId, r.kind, r.title, r.uri, r.status, r.contentHash, r.lastIndexedAt, r.lastError, r.createdAt, r.updatedAt];
}

function sourceRow() {
  const now = new Date("2026-11-08T00:00:00Z");
  return {
    id: "src-1",
    companyId: COMPANY_A,
    chatbotId: CHATBOT,
    kind: "text",
    title: "t",
    uri: null,
    status: "pending",
    contentHash: null,
    lastIndexedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
