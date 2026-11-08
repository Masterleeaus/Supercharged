/**
 * Cal.com secret writer: new rows hold the versioned string, and reads open both the string and the older contract
 * object. The in-memory storage keeps whatever it is given, so these tests check the value the writer hands over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SECRET_KEY_ENV, createSecretBox } from "../secrets/secret-box.ts";
import { createCalendarSecretStore } from "./calendar-secrets.ts";
import { createMemoryRetryStore } from "./memory-retry-store.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const API_KEY = "cal_live_test_key_value";

test("round trip: save writes the versioned string and read returns the plaintext", async () => {
  const storage = createMemoryRetryStore().secrets;
  const store = createCalendarSecretStore({ box, storage });
  await store.save(COMPANY_A, "calcom", "api_key", API_KEY);

  const written = await storage.get(COMPANY_A, "calcom", "api_key");
  assert.equal(typeof written, "string");
  assert.match(String(written), /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!String(written).includes(API_KEY));

  assert.equal(await store.read(COMPANY_A, "calcom", "api_key"), API_KEY);
});

test("legacy read: a contract object already in storage still opens", async () => {
  const storage = createMemoryRetryStore().secrets;
  const legacy = await box.encrypt(COMPANY_A, API_KEY);
  await storage.put(COMPANY_A, "calcom", "api_key", legacy, new Date());

  const store = createCalendarSecretStore({ box, storage });
  assert.equal(await store.read(COMPANY_A, "calcom", "api_key"), API_KEY);
});

test("read returns null when nothing is stored, and another company's row does not open", async () => {
  const storage = createMemoryRetryStore().secrets;
  const store = createCalendarSecretStore({ box, storage });
  assert.equal(await store.read(COMPANY_A, "calcom", "api_key"), null);

  await store.save(COMPANY_A, "calcom", "api_key", API_KEY);
  assert.equal(await store.read(COMPANY_B, "calcom", "api_key"), null);
});
