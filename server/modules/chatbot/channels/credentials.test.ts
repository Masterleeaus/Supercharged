import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createChannelCredentialSource, saveChannelCredentials, type ChannelAccountStorage } from "./credentials.ts";
import { createMemoryChannelAccountStorage } from "./memory-storage.ts";
import { SECRET_KEY_ENV, createSecretBox } from "../secrets/secret-box.ts";
import { toSealedString } from "../secrets/sealed-form.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CREDS = { bot_token: "123:abc-telegram-token", webhook_secret: "hook-secret-value" };

test("save writes the versioned string, and load reads it back", async () => {
  const storage = createMemoryChannelAccountStorage();
  const deps = { storage, secretBox: box };
  await saveChannelCredentials(deps, COMPANY_A, "telegram", "bot-1", CREDS);
  const stored = await storage.findSealed(COMPANY_A, "telegram", "bot-1");
  assert.equal(typeof stored, "string");
  assert.match(String(stored), /^v1:/);

  const loaded = await createChannelCredentialSource(deps).load(COMPANY_A, "telegram", "bot-1");
  assert.deepEqual(loaded, CREDS);
});

test("legacy read: a row stored as the contract object still loads", async () => {
  const legacyObject = await box.encrypt(COMPANY_A, JSON.stringify(CREDS));
  const storage: ChannelAccountStorage = {
    async findSealed() {
      return legacyObject;
    },
    async saveSealed() {
      throw new Error("not used");
    },
  };
  const loaded = await createChannelCredentialSource({ storage, secretBox: box }).load(COMPANY_A, "telegram", "bot-1");
  assert.deepEqual(loaded, CREDS);
});

test("legacy read: the object reaches the source after a JSON round trip (jsonb)", async () => {
  const fromJsonb: unknown = JSON.parse(JSON.stringify(await box.encrypt(COMPANY_A, JSON.stringify(CREDS))));
  const storage: ChannelAccountStorage = {
    async findSealed() {
      return fromJsonb as never;
    },
    async saveSealed() {},
  };
  const loaded = await createChannelCredentialSource({ storage, secretBox: box }).load(COMPANY_A, "telegram", "bot-1");
  assert.deepEqual(loaded, CREDS);
});

test("the string form written to one company does not load for another", async () => {
  const storage = createMemoryChannelAccountStorage();
  await saveChannelCredentials({ storage, secretBox: box }, COMPANY_A, "telegram", "bot-1", CREDS);
  const copied = await storage.findSealed(COMPANY_A, "telegram", "bot-1");
  // A row copied to company B under company B's key lookup: the AAD does not match, so the load returns null.
  const other: ChannelAccountStorage = {
    async findSealed() {
      return copied;
    },
    async saveSealed() {},
  };
  assert.equal(await createChannelCredentialSource({ storage: other, secretBox: box }).load(COMPANY_B, "telegram", "bot-1"), null);
});

test("a malformed stored value fails closed to null", async () => {
  const storage: ChannelAccountStorage = {
    async findSealed() {
      return "v1:not:a-real-value" as never;
    },
    async saveSealed() {},
  };
  assert.equal(await createChannelCredentialSource({ storage, secretBox: box }).load(COMPANY_A, "telegram", "bot-1"), null);
});

test("a string written by the box directly (sealString form) is the same write form", async () => {
  const obj = await box.encrypt(COMPANY_A, JSON.stringify(CREDS));
  const storage: ChannelAccountStorage = {
    async findSealed() {
      return toSealedString(obj);
    },
    async saveSealed() {},
  };
  assert.deepEqual(await createChannelCredentialSource({ storage, secretBox: box }).load(COMPANY_A, "telegram", "bot-1"), CREDS);
});
