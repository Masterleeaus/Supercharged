/**
 * Drizzle credential store for commerce: the jsonb sealed column holds the versioned string as a JSON string, and a
 * record read back through the store still loads. A row written by older code (a contract object) also loads. The
 * database is a stand-in that serialises the sealed value the way jsonb does, so no Postgres is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SECRET_KEY_ENV, createSecretBox } from "../../secrets/secret-box.ts";
import { sealToString } from "../../secrets/sealed-form.ts";
import { createCommerceCredentialService, type CredentialRecord } from "./credentials.ts";
import { createDrizzleCredentialRecordStore, type CommerceDb } from "./drizzle-stores.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const OWNER = { companyId: COMPANY_A, chatbotId: "chatbot-1", ownerUserId: "user-1" };
const CONN_ID = "conn-1";
const TOKEN = "shpat_drizzle_token_value";

/** One-row stand-in: insert/upsert keeps the values (sealed via JSON, as jsonb does); select returns the row. */
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const selectChain = {
    select: () => selectChain,
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [...rows.values()].slice(0, 1).map((r) => ({ ...r, sealed: JSON.parse(JSON.stringify(r.sealed ?? null)) })),
  };
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          rows.set(String(values.id), { ...values });
        },
      }),
    }),
    select: selectChain.select,
  };
  return { db: db as unknown as CommerceDb, rows };
}

test("round trip through the Drizzle store: the stored sealed value is the string and load opens it", async () => {
  const { db, rows } = fakeDb();
  const service = createCommerceCredentialService({
    records: createDrizzleCredentialRecordStore(db),
    secretBox: box,
    now: () => new Date(),
    newId: () => CONN_ID,
  });
  await service.store(OWNER, OWNER.ownerUserId, "shopify", { access_token: TOKEN });

  const sealed = rows.get(CONN_ID)?.sealed;
  assert.equal(typeof sealed, "string");
  assert.match(String(sealed), /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.deepEqual(await service.load(COMPANY_A, CONN_ID), { access_token: TOKEN });
  assert.equal(await service.load(COMPANY_B, CONN_ID), null);
});

test("legacy read: a jsonb row holding the contract object still loads", async () => {
  const { db, rows } = fakeDb();
  const legacy = await box.encrypt(COMPANY_A, JSON.stringify({ access_token: TOKEN }));
  const record: Record<string, unknown> = {
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
  };
  rows.set(CONN_ID, record);

  const service = createCommerceCredentialService({
    records: createDrizzleCredentialRecordStore(db),
    secretBox: box,
    now: () => new Date(),
    newId: () => CONN_ID,
  });
  assert.deepEqual(await service.load(COMPANY_A, CONN_ID), { access_token: TOKEN });
});

test("the record read back from the store carries the string as its sealed value", async () => {
  const { db } = fakeDb();
  const store = createDrizzleCredentialRecordStore(db);
  const record: CredentialRecord = {
    id: CONN_ID,
    companyId: COMPANY_A,
    chatbotId: OWNER.chatbotId,
    ownerUserId: OWNER.ownerUserId,
    provider: "shopify",
    sealed: await sealToString(box, COMPANY_A, "{}"),
    configuration: {},
    fingerprint: null,
    status: "active",
    version: 1,
    lastTestSucceeded: null,
    lastTestedAt: null,
    rotatedAt: null,
    revokedAt: null,
  };
  await store.save(record);
  const back = await store.findById(COMPANY_A, CONN_ID);
  assert.equal(typeof back?.sealed, "string");
  assert.equal(back?.sealed, record.sealed);
});
