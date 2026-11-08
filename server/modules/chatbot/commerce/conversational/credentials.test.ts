/**
 * Commerce credentials: new records hold the versioned string as the sealed value, and load() opens both the string
 * and the older contract object. Records live in an in-memory store here; the Drizzle store has its own test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SECRET_KEY_ENV, createSecretBox } from "../../secrets/secret-box.ts";
import { createCommerceCredentialService, type CredentialRecord, type CredentialRecordStore } from "./credentials.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const OWNER = { companyId: COMPANY_A, chatbotId: "chatbot-1", ownerUserId: "user-1" };
const CONN_ID = "conn-1";
const TOKEN = "shpat_test_token_value";

function memoryRecords(): { store: CredentialRecordStore; rows: Map<string, CredentialRecord> } {
  const rows = new Map<string, CredentialRecord>();
  const store: CredentialRecordStore = {
    async findById(companyId, id) {
      const row = rows.get(id);
      return row && row.companyId === companyId ? { ...row } : null;
    },
    async findByProvider(companyId, chatbotId, provider) {
      const row = [...rows.values()].find((r) => r.companyId === companyId && r.chatbotId === chatbotId && r.provider === provider);
      return row ? { ...row } : null;
    },
    async save(record) {
      rows.set(record.id, { ...record });
    },
  };
  return { store, rows };
}

function serviceWith(store: CredentialRecordStore) {
  return createCommerceCredentialService({ records: store, secretBox: box, now: () => new Date(), newId: () => CONN_ID });
}

test("round trip: store writes the versioned string and load returns the credentials", async () => {
  const { store, rows } = memoryRecords();
  const service = serviceWith(store);
  await service.store(OWNER, OWNER.ownerUserId, "shopify", { access_token: TOKEN });

  const sealed = rows.get(CONN_ID)?.sealed;
  assert.equal(typeof sealed, "string");
  assert.match(String(sealed), /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!String(sealed).includes(TOKEN));

  assert.deepEqual(await service.load(COMPANY_A, CONN_ID), { access_token: TOKEN });
});

test("legacy read: a record holding the contract object still loads", async () => {
  const { store, rows } = memoryRecords();
  const legacy = await box.encrypt(COMPANY_A, JSON.stringify({ access_token: TOKEN }));
  rows.set(CONN_ID, {
    id: CONN_ID,
    companyId: COMPANY_A,
    chatbotId: OWNER.chatbotId,
    ownerUserId: OWNER.ownerUserId,
    provider: "shopify",
    sealed: legacy,
    configuration: { domain: "shop.example" },
    fingerprint: null,
    status: "active",
    version: 1,
    lastTestSucceeded: null,
    lastTestedAt: null,
    rotatedAt: null,
    revokedAt: null,
  });

  const service = serviceWith(store);
  assert.deepEqual(await service.load(COMPANY_A, CONN_ID), { access_token: TOKEN });
});

test("load returns null for another company's connection", async () => {
  const { store } = memoryRecords();
  const service = serviceWith(store);
  await service.store(OWNER, OWNER.ownerUserId, "shopify", { access_token: TOKEN });
  assert.equal(await service.load(COMPANY_B, CONN_ID), null);
});
