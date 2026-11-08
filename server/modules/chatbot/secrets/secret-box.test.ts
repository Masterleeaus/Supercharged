import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SECRET_KEY_ENV, SecretKeyError, SecretOpenError, createSecretBox } from "./secret-box.ts";

const KEY = randomBytes(32).toString("base64");
const env = { [SECRET_KEY_ENV]: KEY };
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const PLAINTEXT = "calendly-token-plain-value-xyz";

function flipLastByte(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[bytes.length - 1] ^= 0x01;
  return bytes.toString("base64");
}

test("round trip: string form, contract form and bookings form", async () => {
  const box = createSecretBox({ env });

  const s = box.sealString(PLAINTEXT, COMPANY_A);
  assert.match(s, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(box.openString(s, COMPANY_A), PLAINTEXT);

  const c = await box.encrypt(COMPANY_A, PLAINTEXT);
  assert.equal(c.v, 1);
  assert.equal(await box.decrypt(COMPANY_A, c), PLAINTEXT);

  const b = box.seal(PLAINTEXT);
  assert.equal(box.open(b), PLAINTEXT);
});

test("each seal uses a fresh IV", () => {
  const box = createSecretBox({ env });
  const first = box.sealString(PLAINTEXT, COMPANY_A);
  const second = box.sealString(PLAINTEXT, COMPANY_A);
  assert.notEqual(first, second);
  assert.notEqual(first.split(":")[1], second.split(":")[1]);
});

test("wrong company fails to open (string and contract forms)", async () => {
  const box = createSecretBox({ env });
  const s = box.sealString(PLAINTEXT, COMPANY_A);
  assert.throws(() => box.openString(s, COMPANY_B), SecretOpenError);

  const c = await box.encrypt(COMPANY_A, PLAINTEXT);
  await assert.rejects(box.decrypt(COMPANY_B, c), SecretOpenError);
});

test("ciphertext sealed with a companyId does not open without one, and the reverse", () => {
  const box = createSecretBox({ env });
  const bound = box.sealString(PLAINTEXT, COMPANY_A);
  assert.throws(() => box.openString(bound), SecretOpenError);
  const unbound = box.sealString(PLAINTEXT);
  assert.throws(() => box.openString(unbound, COMPANY_A), SecretOpenError);
});

test("tampered ciphertext fails", async () => {
  const box = createSecretBox({ env });
  const [version, iv, tag, ct] = box.sealString(PLAINTEXT, COMPANY_A).split(":");
  assert.throws(() => box.openString([version, iv, tag, flipLastByte(ct)].join(":"), COMPANY_A), SecretOpenError);
  assert.throws(() => box.openString([version, iv, flipLastByte(tag), ct].join(":"), COMPANY_A), SecretOpenError);

  const c = await box.encrypt(COMPANY_A, PLAINTEXT);
  await assert.rejects(box.decrypt(COMPANY_A, { ...c, ciphertext: flipLastByte(c.ciphertext) }), SecretOpenError);

  const b = box.seal(PLAINTEXT);
  assert.throws(() => box.open({ ...b, ciphertext: flipLastByte(b.ciphertext) }), SecretOpenError);
});

test("unknown version and wrong shape fail", () => {
  const box = createSecretBox({ env });
  const [, iv, tag, ct] = box.sealString(PLAINTEXT, COMPANY_A).split(":");
  assert.throws(() => box.openString(["v2", iv, tag, ct].join(":"), COMPANY_A), SecretOpenError);
  assert.throws(() => box.openString("v1:only-two-parts", COMPANY_A), SecretOpenError);
});

test("a different key cannot open the value", () => {
  const sealed = createSecretBox({ env }).sealString(PLAINTEXT, COMPANY_A);
  const other = createSecretBox({ env: { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") } });
  assert.throws(() => other.openString(sealed, COMPANY_A), SecretOpenError);
});

test("missing key fails closed at construction", () => {
  assert.throws(() => createSecretBox({ env: {} }), SecretKeyError);
  assert.throws(() => createSecretBox({ env: { [SECRET_KEY_ENV]: "" } }), SecretKeyError);
});

test("wrong key length fails closed at construction", () => {
  for (const bytes of [0, 16, 31, 33, 64]) {
    assert.throws(
      () => createSecretBox({ env: { [SECRET_KEY_ENV]: randomBytes(bytes).toString("base64") } }),
      SecretKeyError,
      `length ${bytes}`,
    );
  }
  assert.throws(() => createSecretBox({ env: { [SECRET_KEY_ENV]: `${KEY}!` } }), SecretKeyError);
});

test("errors do not contain the plaintext, the key, or the sealed bytes", () => {
  const box = createSecretBox({ env });
  const [version, iv, tag, ct] = box.sealString(PLAINTEXT, COMPANY_A).split(":");
  const tampered = [version, iv, tag, flipLastByte(ct)].join(":");
  assert.throws(
    () => box.openString(tampered, COMPANY_A),
    (err: Error) => {
      const text = `${err.name} ${err.message}`;
      return !text.includes(PLAINTEXT) && !text.includes(KEY) && !text.includes(ct);
    },
  );
  const badKey = "c2hvcnQ=";
  assert.throws(
    () => createSecretBox({ env: { [SECRET_KEY_ENV]: badKey } }),
    (err: Error) => !err.message.includes(badKey) && !err.message.includes(KEY),
  );
});

// Keyring: versions, rotation and fail-closed cases.
const V1_KEY = KEY;
const V2_KEY = randomBytes(32).toString("base64");
const ring = (extra: Record<string, string>) => JSON.stringify(extra);

test("keyring: seal uses the current version and open reads the version prefix", () => {
  const box = createSecretBox({
    env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: V2_KEY }), CHATBOT_SECRET_KEY_VERSION: "v2" },
  });
  const s = box.sealString(PLAINTEXT, COMPANY_A);
  assert.match(s, /^v2:[^:]+:[^:]+:[^:]+$/);
  assert.equal(box.openString(s, COMPANY_A), PLAINTEXT);

  const b = box.seal(PLAINTEXT);
  assert.equal(b.keyId, "v2");
  assert.equal(box.open(b), PLAINTEXT);
});

test("keyring: a v1 value still opens after the current version becomes v2", async () => {
  const oldBox = createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY } });
  const oldString = oldBox.sealString(PLAINTEXT, COMPANY_A);
  const oldContract = await oldBox.encrypt(COMPANY_A, PLAINTEXT);
  const oldBookings = oldBox.seal(PLAINTEXT);
  const legacyBookings = { iv: oldBookings.iv, tag: oldBookings.tag, ciphertext: oldBookings.ciphertext };

  const rotated = createSecretBox({
    env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: V2_KEY }), CHATBOT_SECRET_KEY_VERSION: "v2" },
  });
  assert.equal(rotated.openString(oldString, COMPANY_A), PLAINTEXT);
  assert.equal(await rotated.decrypt(COMPANY_A, oldContract), PLAINTEXT);
  assert.equal(rotated.open(oldBookings), PLAINTEXT);
  assert.equal(rotated.open(legacyBookings), PLAINTEXT, "row with no keyId was sealed with v1");

  const fresh = rotated.sealString(PLAINTEXT, COMPANY_A);
  assert.match(fresh, /^v2:/);
  assert.equal((await rotated.encrypt(COMPANY_A, PLAINTEXT)).keyId, "v2");
});

test("keyring: a v2 value is not opened by a box that only knows v1", () => {
  const v2Box = createSecretBox({
    env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: V2_KEY }), CHATBOT_SECRET_KEY_VERSION: "v2" },
  });
  const sealed = v2Box.sealString(PLAINTEXT, COMPANY_A);
  const v1Only = createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY } });
  assert.throws(() => v1Only.openString(sealed, COMPANY_A), SecretOpenError);
});

test("keyring: unknown version is refused with the generic open error", async () => {
  const box = createSecretBox({
    env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: V2_KEY }), CHATBOT_SECRET_KEY_VERSION: "v2" },
  });
  const [, iv, tag, ct] = box.sealString(PLAINTEXT, COMPANY_A).split(":");
  for (const version of ["v3", "__proto__", "constructor", "V2", ""]) {
    assert.throws(() => box.openString([version, iv, tag, ct].join(":"), COMPANY_A), SecretOpenError, version);
  }
  const c = await box.encrypt(COMPANY_A, PLAINTEXT);
  await assert.rejects(box.decrypt(COMPANY_A, { ...c, keyId: "v9" }), SecretOpenError);
  assert.throws(() => box.open({ iv, tag, ciphertext: ct, keyId: "v9" }), SecretOpenError);
});

test("keyring: current version must exist in the keyring", () => {
  assert.throws(
    () => createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEY_VERSION: "v2" } }),
    SecretKeyError,
  );
  assert.throws(
    () => createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEY_VERSION: "bad:version" } }),
    SecretKeyError,
  );
});

test("keyring: wrong length keys are refused at construction", () => {
  for (const bytes of [0, 16, 31, 33]) {
    const short = randomBytes(bytes).toString("base64");
    assert.throws(
      () => createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: short }) } }),
      SecretKeyError,
      `ring length ${bytes}`,
    );
  }
  assert.throws(
    () => createSecretBox({ env: { [SECRET_KEY_ENV]: randomBytes(16).toString("base64") } }),
    SecretKeyError,
  );
});

test("keyring: malformed keyring JSON and shapes are refused", () => {
  const bad = [
    "{not json",
    "[]",
    "\"v2\"",
    ring({ "bad name": V2_KEY }),
    ring({ v2: 42 as unknown as string }),
  ];
  for (const raw of bad) {
    assert.throws(
      () => createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: raw } }),
      SecretKeyError,
      raw,
    );
  }
});

test("keyring: a conflicting v1 entry is refused", () => {
  assert.throws(
    () => createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v1: V2_KEY }) } }),
    SecretKeyError,
  );
  // The same v1 key listed again is harmless.
  assert.doesNotThrow(() => createSecretBox({ env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v1: V1_KEY }) } }));
});

test("keyring: no key material in any error text", () => {
  const cases: Array<{ env: Record<string, string> }> = [
    { env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: `{"v2": "${V2_KEY.slice(0, 10)}!` } },
    { env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: `${V2_KEY}!` }) } },
    { env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v1: V2_KEY }) } },
    { env: { [SECRET_KEY_ENV]: V1_KEY, CHATBOT_SECRET_KEYRING: ring({ v2: V2_KEY }), CHATBOT_SECRET_KEY_VERSION: "v3" } },
  ];
  for (const { env: e } of cases) {
    assert.throws(
      () => createSecretBox({ env: e }),
      (err: Error) => {
        const text = `${err.name} ${err.message}`;
        return err instanceof SecretKeyError && !text.includes(V1_KEY) && !text.includes(V2_KEY);
      },
    );
  }
});
