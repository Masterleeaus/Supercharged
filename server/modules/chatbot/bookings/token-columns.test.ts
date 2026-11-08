/**
 * Calendly token columns. The current write form is one versioned string in the ciphertext column, with the iv and tag
 * columns null. A row in the older three-column layout must still open. No database is used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createSecretBox,
  openCalendlyTokenColumns,
  sealCalendlyTokenColumns,
} from "./secret-box.ts";
import { SECRET_KEY_ENV, SecretOpenError } from "../secrets/secret-box.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const TOKEN = "calendly-personal-access-token-xyz";

test("write form: the token goes into the ciphertext column as the versioned string, iv and tag null", () => {
  const box = createSecretBox({ env });
  const columns = sealCalendlyTokenColumns(box, TOKEN);
  assert.equal(columns.calendlyTokenIv, null);
  assert.equal(columns.calendlyTokenTag, null);
  assert.match(columns.calendlyTokenCiphertext, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(columns.calendlyTokenCiphertext.includes(TOKEN), false);
});

test("round trip through the current write form", () => {
  const box = createSecretBox({ env });
  const columns = sealCalendlyTokenColumns(box, TOKEN);
  assert.equal(openCalendlyTokenColumns(box, columns), TOKEN);
});

test("legacy read: a three-column row written by the older code still opens", () => {
  const box = createSecretBox({ env });
  const legacy = box.seal(TOKEN);
  const row = {
    calendlyTokenIv: legacy.iv,
    calendlyTokenTag: legacy.tag,
    calendlyTokenCiphertext: legacy.ciphertext,
  };
  assert.equal(openCalendlyTokenColumns(box, row), TOKEN);
});

test("no token stored returns null", () => {
  const box = createSecretBox({ env });
  assert.equal(openCalendlyTokenColumns(box, { calendlyTokenIv: null, calendlyTokenTag: null, calendlyTokenCiphertext: null }), null);
});

test("a damaged legacy row fails with the generic open error", () => {
  const box = createSecretBox({ env });
  const legacy = box.seal(TOKEN);
  const damaged = { calendlyTokenIv: legacy.iv, calendlyTokenTag: legacy.tag, calendlyTokenCiphertext: flipFirstByte(legacy.ciphertext) };
  assert.throws(() => openCalendlyTokenColumns(box, damaged), SecretOpenError);
});

test("a damaged string in the current form fails with the generic open error", () => {
  const box = createSecretBox({ env });
  const columns = sealCalendlyTokenColumns(box, TOKEN);
  const [version, iv, tag, ct] = columns.calendlyTokenCiphertext.split(":");
  const broken = { calendlyTokenIv: null, calendlyTokenTag: null, calendlyTokenCiphertext: [version, iv, tag, flipFirstByte(ct)].join(":") };
  assert.throws(() => openCalendlyTokenColumns(box, broken), SecretOpenError);
});

function flipFirstByte(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[0] ^= 0x01;
  return bytes.toString("base64");
}
