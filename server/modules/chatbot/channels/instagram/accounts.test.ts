import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createInstagramCredentialSource,
  createMemoryInstagramAccountStorage,
  openCredentials,
  sealCredentials,
  type InstagramAccountRecord,
} from "./accounts.ts";
import { SECRET_KEY_ENV, createSecretBox } from "../../secrets/secret-box.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CREDS = {
  instagram_id: "17841400000000000",
  page_id: "1000001",
  username: "shop_acct",
  access_token: "EAAG-long-lived-token-value",
  app_id: "app-1",
  app_secret: "app-secret-value",
};

function recordFor(companyId: string, sealed: InstagramAccountRecord["sealedCredentials"]): InstagramAccountRecord {
  const now = new Date("2026-11-01T00:00:00Z");
  return {
    companyId,
    id: "17841400000000000",
    pageId: "1000001",
    username: "shop_acct",
    sealedCredentials: sealed,
    tokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

test("seal produces the versioned string and open reads it back", async () => {
  const sealed = await sealCredentials(box, COMPANY_A, CREDS);
  assert.equal(typeof sealed, "string");
  assert.match(sealed, /^v1:/);
  assert.deepEqual(await openCredentials(box, COMPANY_A, sealed), CREDS);
});

test("legacy read: the older contract object still opens", async () => {
  const legacy = await box.encrypt(COMPANY_A, JSON.stringify(CREDS));
  const fromJsonb: unknown = JSON.parse(JSON.stringify(legacy));
  assert.deepEqual(await openCredentials(box, COMPANY_A, fromJsonb as never), CREDS);
});

test("a copied value does not open under another company (returns null, does not throw)", async () => {
  const sealed = await sealCredentials(box, COMPANY_A, CREDS);
  assert.equal(await openCredentials(box, COMPANY_B, sealed), null);
  const legacy = await box.encrypt(COMPANY_A, JSON.stringify(CREDS));
  assert.equal(await openCredentials(box, COMPANY_B, legacy), null);
});

test("a damaged or malformed value returns null", async () => {
  assert.equal(await openCredentials(box, COMPANY_A, "v1:not:valid" as never), null);
  const sealed = await sealCredentials(box, COMPANY_A, CREDS);
  const [version, iv, tag, ct] = sealed.split(":");
  const bytes = Buffer.from(ct, "base64");
  bytes[0] ^= 0x01;
  assert.equal(await openCredentials(box, COMPANY_A, [version, iv, tag, bytes.toString("base64")].join(":")), null);
});

test("credential source loads a string written through storage, and a legacy object row", async () => {
  const storage = createMemoryInstagramAccountStorage();
  const sealed = await sealCredentials(box, COMPANY_A, CREDS);
  await storage.upsert(COMPANY_A, recordFor(COMPANY_A, sealed));
  const source = createInstagramCredentialSource(storage, box);
  assert.deepEqual(await source.load(COMPANY_A, "instagram", "17841400000000000"), CREDS);

  const legacyStorage = createMemoryInstagramAccountStorage();
  await legacyStorage.upsert(COMPANY_A, recordFor(COMPANY_A, await box.encrypt(COMPANY_A, JSON.stringify(CREDS))));
  const legacySource = createInstagramCredentialSource(legacyStorage, box);
  assert.deepEqual(await legacySource.load(COMPANY_A, "instagram", "17841400000000000"), CREDS);

  assert.equal(await source.load(COMPANY_B, "instagram", "17841400000000000"), null);
});
