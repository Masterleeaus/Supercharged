/**
 * Widget embed signing key read path: the stored row may be the versioned string (current writes) or the contract
 * object (older rows). Both must open for the owning company, and a row read under another company must fail closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DrizzleWidgetStorage, type WidgetDb } from "./storage.ts";
import { SECRET_KEY_ENV, createSecretBox } from "../secrets/secret-box.ts";
import { sealToString } from "../secrets/sealed-form.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SIGNING_KEY = randomBytes(32).toString("hex");

/** Stand-in for the drizzle chain selectActiveSigningKeyQuery() uses. limit() resolves the rows. */
function fakeDb(rows: Array<{ sealed: unknown }>): WidgetDb {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return chain as unknown as WidgetDb;
}

test("signing key: the versioned string opens for its own company", async () => {
  const sealed = await sealToString(box, COMPANY_A, SIGNING_KEY);
  const storage = new DrizzleWidgetStorage(fakeDb([{ sealed }]), box);
  assert.equal(await storage.signingKeyFor(COMPANY_A), SIGNING_KEY);
});

test("signing key: a legacy contract object still opens", async () => {
  const legacy = await box.encrypt(COMPANY_A, SIGNING_KEY);
  const fromJsonb: unknown = JSON.parse(JSON.stringify(legacy));
  const storage = new DrizzleWidgetStorage(fakeDb([{ sealed: fromJsonb }]), box);
  assert.equal(await storage.signingKeyFor(COMPANY_A), SIGNING_KEY);
});

test("signing key: a row read under another company fails closed to null", async () => {
  const sealed = await sealToString(box, COMPANY_A, SIGNING_KEY);
  const storage = new DrizzleWidgetStorage(fakeDb([{ sealed }]), box);
  assert.equal(await storage.signingKeyFor(COMPANY_B), null);
});

test("signing key: no active key returns null, and a malformed value fails closed", async () => {
  assert.equal(await new DrizzleWidgetStorage(fakeDb([]), box).signingKeyFor(COMPANY_A), null);
  assert.equal(await new DrizzleWidgetStorage(fakeDb([{ sealed: "v1:bad" }]), box).signingKeyFor(COMPANY_A), null);
});
