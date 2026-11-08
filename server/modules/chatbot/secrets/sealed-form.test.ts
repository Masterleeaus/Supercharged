import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openStored, parseSealedString, sealToString, toSealedString } from "./sealed-form.ts";
import { SECRET_KEY_ENV, SecretOpenError, createSecretBox } from "./secret-box.ts";

const KEY = randomBytes(32).toString("base64");
const env = { [SECRET_KEY_ENV]: KEY };
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const PLAINTEXT = JSON.stringify({ access_token: "tok-plain-value-xyz", app_id: "123" });

test("write form: sealToString gives the versioned string and openStored reads it back", async () => {
  const box = createSecretBox({ env });
  const stored = await sealToString(box, COMPANY_A, PLAINTEXT);
  assert.equal(typeof stored, "string");
  assert.match(stored, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(await openStored(box, COMPANY_A, stored), PLAINTEXT);
});

test("legacy read: a contract object written by the older code still opens", async () => {
  const box = createSecretBox({ env });
  const legacy = await box.encrypt(COMPANY_A, PLAINTEXT);
  assert.equal(typeof legacy, "object");
  assert.equal(await openStored(box, COMPANY_A, legacy), PLAINTEXT);
  // A JSON round trip (the shape a jsonb column hands back) is the same object.
  const fromJson: unknown = JSON.parse(JSON.stringify(legacy));
  assert.equal(await openStored(box, COMPANY_A, fromJson), PLAINTEXT);
});

test("the string form and the contract object agree on the bytes", async () => {
  const box = createSecretBox({ env });
  const obj = await box.encrypt(COMPANY_A, PLAINTEXT);
  const str = toSealedString(obj);
  assert.deepEqual(parseSealedString(str), { v: 1, alg: obj.alg, keyId: obj.keyId, iv: obj.iv, tag: obj.tag, ciphertext: obj.ciphertext });
  assert.equal(await openStored(box, COMPANY_A, str), PLAINTEXT);
});

test("wrong company fails for both forms", async () => {
  const box = createSecretBox({ env });
  const str = await sealToString(box, COMPANY_A, PLAINTEXT);
  const obj = await box.encrypt(COMPANY_A, PLAINTEXT);
  await assert.rejects(openStored(box, COMPANY_B, str), SecretOpenError);
  await assert.rejects(openStored(box, COMPANY_B, obj), SecretOpenError);
});

test("the key version in the prefix is what is stored, not a fixed v1", async () => {
  const box = createSecretBox({ env });
  const obj = await box.encrypt(COMPANY_A, PLAINTEXT);
  const v2 = { ...obj, keyId: "v2" };
  assert.match(toSealedString(v2), /^v2:/);
  assert.deepEqual(parseSealedString(toSealedString(v2))?.keyId, "v2");
});

test("toSealedString refuses a shape it cannot store losslessly", () => {
  const good = { v: 1 as const, alg: "aes-256-gcm" as const, keyId: "v1", iv: "AAAA", tag: "AAAA", ciphertext: "AAAA" };
  assert.throws(() => toSealedString({ ...good, alg: "des" as never }), TypeError);
  assert.throws(() => toSealedString({ ...good, keyId: "key-one" }), TypeError);
  assert.throws(() => toSealedString({ ...good, v: 2 as never }), TypeError);
});

test("parseSealedString rejects anything that is not the write form", () => {
  assert.equal(parseSealedString("v1:only:three"), null);
  assert.equal(parseSealedString("v1:a:b:c:d"), null);
  assert.equal(parseSealedString("x1:AAAA:AAAA:AAAA"), null);
  assert.equal(parseSealedString("v1::AAAA:AAAA"), null);
  assert.equal(parseSealedString("v1:AA AA:AAAA:AAAA"), null);
  assert.equal(parseSealedString(""), null);
});

test("openStored refuses malformed strings, nulls and other types with the generic error", async () => {
  const box = createSecretBox({ env });
  for (const bad of ["not-a-sealed-value", "v1:zz:zz:zz", "", 42, null, undefined, true]) {
    await assert.rejects(openStored(box, COMPANY_A, bad), SecretOpenError);
  }
});

test("openStored: a tampered string fails", async () => {
  const box = createSecretBox({ env });
  const [version, iv, tag, ct] = (await sealToString(box, COMPANY_A, PLAINTEXT)).split(":");
  const bytes = Buffer.from(ct, "base64");
  bytes[bytes.length - 1] ^= 0x01;
  await assert.rejects(openStored(box, COMPANY_A, [version, iv, tag, bytes.toString("base64")].join(":")), SecretOpenError);
});

test("no plaintext or key in an error from a failed open", async () => {
  const box = createSecretBox({ env });
  const str = await sealToString(box, COMPANY_A, PLAINTEXT);
  try {
    await openStored(box, COMPANY_B, str);
    assert.fail("expected an open failure");
  } catch (error) {
    const text = String((error as Error).message) + String((error as Error).stack ?? "");
    assert.equal(text.includes(PLAINTEXT), false);
    assert.equal(text.includes(KEY), false);
  }
});
