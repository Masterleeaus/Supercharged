// Channel framework and WhatsApp (Twilio) provider tests (node:test). No network: every outbound call goes through
// an injected fake HttpClient, and globalThis.fetch is replaced with a function that throws.
// Covers: registry refuses unknown kinds, bad signatures refused before parsing, inbound maps to the shared shape,
// credentials never appear in a response, send request shape and error mapping, idempotency, encrypted credential
// storage bound to the company, company-scoped Drizzle SQL, and the WhatsApp flag.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import {
  buildFindSealedQuery,
  buildSaveSealedQuery,
  ChannelRegistryError,
  checkParseResults,
  computeTwilioSignature,
  createChannelCredentialSource,
  createChannelRegistry,
  createMemoryChannelAccountStorage,
  createWhatsappProvider,
  isWhatsappChannelEnabled,
  normaliseWhatsappAddress,
  receiveWebhook,
  redactSecrets,
  saveChannelCredentials,
  sendOutbound,
  validateCredentials,
  WHATSAPP_CHANNEL_FLAG,
} from "../../server/modules/chatbot/channels/index.ts";

// ---------- fixtures ----------

const COMPANY_A = "6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51";
const COMPANY_B = "b2d4f6a8-1c3e-4f50-9a7b-6c5d4e3f2a12";
const RECEIVED = new Date("2026-11-08T03:00:00.000Z");
const ACCOUNT = "+61400111222";
const TOKEN = "tok_test_9f3a1c7e5b2d4a60";
const ACCOUNT_SID = "AC" + "1234567890abcdef".repeat(2);
const WEBHOOK_URL = "https://app.example.test/api/chatbot/whatsapp/hook";
const CUSTOMER = "+61412345678";
const CREDS = {
  whatsapp_sid: ACCOUNT_SID,
  whatsapp_token: TOKEN,
  whatsapp_phone: ACCOUNT,
  whatsapp_environment: "production",
  webhook_url: WEBHOOK_URL,
};
const MESSAGE_SID = "SM" + "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

// Replaces the global fetch for the whole file. Any code that reaches it fails the test run.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => {
    throw new Error("network access is not allowed in tests");
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

/** Test-only AES-256-GCM box. The company id is bound as associated data, as the SecretBox contract requires. */
function makeSecretBox() {
  const key = randomBytes(32);
  return {
    async encrypt(companyId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(companyId, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        v: 1,
        alg: "aes-256-gcm",
        keyId: "v1",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },
    async decrypt(companyId, sealed) {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAAD(Buffer.from(companyId, "utf8"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

function inboundForm(overrides = {}) {
  return {
    MessageSid: MESSAGE_SID,
    SmsSid: MESSAGE_SID,
    AccountSid: ACCOUNT_SID,
    From: `whatsapp:${CUSTOMER}`,
    To: `whatsapp:${ACCOUNT}`,
    WaId: CUSTOMER.slice(1),
    ProfileName: "Dana",
    MessageType: "text",
    Body: "Hi, are you open on Saturday?",
    NumMedia: "0",
    ...overrides,
  };
}

/** A raw webhook signed the way Twilio signs it, for the given URL and token. */
function signedWebhook(form, { token = TOKEN, url = WEBHOOK_URL, receivedAt = RECEIVED } = {}) {
  const rawBody = new URLSearchParams(form).toString();
  const signature = computeTwilioSignature(token, url, [...new URLSearchParams(rawBody).entries()]);
  return { headers: { "x-twilio-signature": signature }, rawBody, receivedAt };
}

/** Records every request and answers with the scripted response or error. */
function fakeHttp(script) {
  const calls = [];
  const http = async (request) => {
    calls.push(request);
    const next = typeof script === "function" ? script(request, calls.length) : script;
    if (next instanceof Error) throw next;
    return next;
  };
  return { http, calls };
}

function okTwilio(sid = MESSAGE_SID) {
  return { status: 201, headers: {}, body: JSON.stringify({ sid, status: "queued", direction: "outbound-api" }) };
}

function outbound(overrides = {}) {
  return {
    channel: "whatsapp",
    accountId: ACCOUNT,
    recipient: CUSTOMER,
    contentKind: "text",
    text: "We are open 9 to 4 on Saturday.",
    attachmentUrl: null,
    templateName: null,
    templateParams: null,
    replyToExternalMessageId: null,
    idempotencyKey: "msg-0001",
    ...overrides,
  };
}

/** Registry with the WhatsApp provider, a credential store holding CREDS for company A, and the fake box. */
async function setup({ creds = CREDS, companyId = COMPANY_A } = {}) {
  const registry = createChannelRegistry();
  registry.register(createWhatsappProvider());
  const secretBox = makeSecretBox();
  const storage = createMemoryChannelAccountStorage();
  const deps = { storage, secretBox };
  if (creds) await saveChannelCredentials(deps, companyId, "whatsapp", ACCOUNT, creds);
  const credentials = createChannelCredentialSource(deps);
  return { registry, credentials, storage, secretBox };
}

// ---------- registry ----------

test("registry refuses an unknown channel kind", async () => {
  const registry = createChannelRegistry();
  registry.register(createWhatsappProvider());

  assert.throws(() => registry.get("sms"), (error) => error instanceof ChannelRegistryError && error.code === "CHANNEL_KIND_UNKNOWN");
  assert.throws(() => registry.get(undefined), (error) => error.code === "CHANNEL_KIND_UNKNOWN");
  assert.throws(() => registry.get("__proto__"), (error) => error.code === "CHANNEL_KIND_UNKNOWN");
  assert.equal(registry.has("sms"), false);

  // A kind that is valid but has no provider yet is also refused.
  assert.throws(() => registry.get("telegram"), (error) => error.code === "CHANNEL_NOT_REGISTERED");

  // A provider that declares an unknown kind cannot be registered.
  const rogue = { ...createWhatsappProvider(), kind: "sms" };
  assert.throws(() => registry.register(rogue), (error) => error.code === "CHANNEL_KIND_UNKNOWN");

  // A second provider for the same kind is refused.
  assert.throws(() => registry.register(createWhatsappProvider()), (error) => error.code === "CHANNEL_KIND_DUPLICATE");
  assert.deepEqual(registry.kinds(), ["whatsapp"]);
});

test("receiveWebhook rejects an unknown kind before touching credentials", async () => {
  const { registry, credentials } = await setup();
  let loads = 0;
  const counting = { load: async (...args) => { loads += 1; return credentials.load(...args); } };
  const receipt = await receiveWebhook({ registry, credentials: counting }, COMPANY_A, "sms", signedWebhook(inboundForm()));
  assert.deepEqual(receipt, { ok: false, reason: "kind_unknown" });
  assert.equal(loads, 0);
});

// ---------- signature verification ----------

test("Twilio signature matches the known-answer vector (token 12345, SDK-style test vector)", () => {
  // Source: NOT verified against the official docs. The official page (https://www.twilio.com/docs/usage/webhooks/webhooks-security)
  // publishes a form example (URL https://mycompany.com/myapp, Caller/From +12349013030, expected Np1nax6uFoY6qpfT5l9jWwJeit0=)
  // but gives no auth token, so it cannot be reproduced. This vector (token 12345, URL with query string) is recalled from the
  // Twilio SDK validation tests; it pins our algorithm (HMAC-SHA1, sorted name+value appended to the full URL, base64).
  // Re-check against the SDK test source before treating it as an official vector.
  const entries = [
    ["CallSid", "CA1234567890ABCDE"],
    ["Caller", "+14158675310"],
    ["Digits", "1234"],
    ["From", "+14158675310"],
    ["To", "+18005551212"],
  ];
  assert.equal(
    computeTwilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", entries),
    "GvWf1cFY/Q7PnoempGyD5oXAezc=",
  );
});

test("a bad signature is refused and parsing never runs", async () => {
  const { registry, credentials } = await setup();
  const base = createWhatsappProvider();
  let parseCalls = 0;
  const spied = { ...base, parseInbound: (...args) => { parseCalls += 1; return base.parseInbound(...args); } };
  const spiedRegistry = createChannelRegistry();
  spiedRegistry.register(spied);
  const deps = { registry: spiedRegistry, credentials };

  // Signed with the wrong token.
  const wrongToken = await receiveWebhook(deps, COMPANY_A, "whatsapp", signedWebhook(inboundForm(), { token: "not-the-token" }));
  assert.deepEqual(wrongToken, { ok: false, reason: "signature_invalid" });

  // Body changed after signing.
  const signed = signedWebhook(inboundForm());
  const tampered = { ...signed, rawBody: signed.rawBody.replace("Saturday", "Sunday") };
  assert.deepEqual(await receiveWebhook(deps, COMPANY_A, "whatsapp", tampered), { ok: false, reason: "signature_invalid" });

  // Signed for a different callback URL.
  const otherUrl = await receiveWebhook(deps, COMPANY_A, "whatsapp", signedWebhook(inboundForm(), { url: "https://evil.example.test/hook" }));
  assert.deepEqual(otherUrl, { ok: false, reason: "signature_invalid" });

  // No signature header at all.
  const missing = { ...signed, headers: {} };
  assert.deepEqual(await receiveWebhook(deps, COMPANY_A, "whatsapp", missing), { ok: false, reason: "signature_missing" });

  assert.equal(parseCalls, 0, "parseInbound must not run before verification passes");
});

test("a channel account with no secret, or no callback URL, is refused", async () => {
  const registry = createChannelRegistry();
  registry.register(createWhatsappProvider());

  // Stored credentials with the token blanked: the pipeline must not verify against an empty secret.
  const blankToken = { load: async () => ({ ...CREDS, whatsapp_token: "" }) };
  assert.deepEqual(
    await receiveWebhook({ registry, credentials: blankToken }, COMPANY_A, "whatsapp", signedWebhook(inboundForm(), { token: "" })),
    { ok: false, reason: "credentials_missing" },
  );

  // No callback URL stored: Twilio's signature cannot be recomputed, so the request is refused.
  const { webhook_url: _dropped, ...withoutUrl } = CREDS;
  const noUrl = { load: async () => withoutUrl };
  assert.deepEqual(
    await receiveWebhook({ registry, credentials: noUrl }, COMPANY_A, "whatsapp", signedWebhook(inboundForm())),
    { ok: false, reason: "credentials_missing" },
  );
});

test("a provider that returns a bare true, or throws, is still refused", async () => {
  const { credentials } = await setup();
  const base = createWhatsappProvider();
  const bareTrue = createChannelRegistry();
  bareTrue.register({ ...base, verifyWebhook: async () => true });
  assert.deepEqual(
    await receiveWebhook({ registry: bareTrue, credentials }, COMPANY_A, "whatsapp", signedWebhook(inboundForm())),
    { ok: false, reason: "signature_invalid" },
  );

  const throws = createChannelRegistry();
  throws.register({ ...base, verifyWebhook: async () => { throw new Error("boom"); } });
  assert.deepEqual(
    await receiveWebhook({ registry: throws, credentials }, COMPANY_A, "whatsapp", signedWebhook(inboundForm())),
    { ok: false, reason: "signature_invalid" },
  );
});

test("a webhook for an account the company has not connected is refused", async () => {
  const { registry, credentials } = await setup();
  const otherNumber = signedWebhook(inboundForm({ To: "whatsapp:+61499999999" }));
  assert.deepEqual(
    await receiveWebhook({ registry, credentials }, COMPANY_A, "whatsapp", otherNumber),
    { ok: false, reason: "credentials_missing" },
  );
  // A webhook with no To field resolves to no account.
  const { To: _to, ...noToFields } = inboundForm();
  const noTo = signedWebhook(noToFields);
  assert.deepEqual(await receiveWebhook({ registry, credentials }, COMPANY_A, "whatsapp", noTo), { ok: false, reason: "account_unknown" });
});

// ---------- inbound normalisation ----------

test("an inbound WhatsApp text maps to the shared InboundMessage shape", async () => {
  const { registry, credentials } = await setup();
  const receipt = await receiveWebhook({ registry, credentials }, COMPANY_A, "whatsapp", signedWebhook(inboundForm()));

  assert.equal(receipt.ok, true);
  assert.equal(receipt.channel, "whatsapp");
  assert.equal(receipt.accountId, ACCOUNT);
  assert.equal(receipt.events.length, 1);
  assert.deepEqual(receipt.events[0], {
    kind: "message",
    message: {
      channel: "whatsapp",
      accountId: ACCOUNT,
      externalThreadId: CUSTOMER,
      externalMessageId: MESSAGE_SID,
      sender: { externalId: CUSTOMER, displayName: "Dana" },
      contentKind: "text",
      text: "Hi, are you open on Saturday?",
      attachments: [],
      sentAt: RECEIVED,
    },
  });
});

test("an inbound image maps to an image content kind with an attachment reference", async () => {
  const { registry, credentials } = await setup();
  const mediaUrl = "https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME1";
  const form = inboundForm({ MessageType: "image", Body: "Our quote", NumMedia: "1", MediaUrl0: mediaUrl, MediaContentType0: "image/jpeg" });
  const receipt = await receiveWebhook({ registry, credentials }, COMPANY_A, "whatsapp", signedWebhook(form));
  const message = receipt.events[0].message;
  assert.equal(message.contentKind, "image");
  assert.equal(message.text, "Our quote");
  assert.deepEqual(message.attachments, [{ kind: "image", externalRef: mediaUrl, mimeType: "image/jpeg", sizeBytes: null }]);
});

test("a delivery status callback maps to a status update, and queued is ignored", async () => {
  const { registry, credentials } = await setup();
  const deps = { registry, credentials };

  const delivered = signedWebhook({ MessageSid: MESSAGE_SID, MessageStatus: "delivered", To: `whatsapp:${CUSTOMER}`, From: `whatsapp:${ACCOUNT}` });
  const r1 = await receiveWebhook(deps, COMPANY_A, "whatsapp", delivered);
  assert.deepEqual(r1.events, [{
    kind: "status",
    update: { channel: "whatsapp", accountId: ACCOUNT, externalMessageId: MESSAGE_SID, status: "delivered", reason: null, occurredAt: RECEIVED },
  }]);

  const undelivered = signedWebhook({ MessageSid: MESSAGE_SID, MessageStatus: "undelivered", ErrorCode: "63016", To: `whatsapp:${CUSTOMER}`, From: `whatsapp:${ACCOUNT}` });
  const r2 = await receiveWebhook(deps, COMPANY_A, "whatsapp", undelivered);
  assert.equal(r2.events[0].update.status, "failed");
  assert.equal(r2.events[0].update.reason, "twilio_error_63016");

  const queued = signedWebhook({ MessageSid: MESSAGE_SID, MessageStatus: "queued", To: `whatsapp:${CUSTOMER}`, From: `whatsapp:${ACCOUNT}` });
  const r3 = await receiveWebhook(deps, COMPANY_A, "whatsapp", queued);
  assert.deepEqual(r3.events, [{ kind: "ignored", reason: "status_queued" }]);
});

test("a provider result that names another account is refused as a parse failure", () => {
  const good = { kind: "ignored", reason: "x" };
  assert.deepEqual(checkParseResults([good], "whatsapp", ACCOUNT), { ok: true, results: [good] });
  const wrongAccount = {
    kind: "status",
    update: { channel: "whatsapp", accountId: "+61499999999", externalMessageId: "SM1", status: "sent", reason: null, occurredAt: RECEIVED },
  };
  assert.deepEqual(checkParseResults([wrongAccount], "whatsapp", ACCOUNT), { ok: false });
  assert.deepEqual(checkParseResults("not an array", "whatsapp", ACCOUNT), { ok: false });
});

// ---------- credentials ----------

test("a credential never appears in a webhook receipt, accepted or rejected", async () => {
  const { registry, credentials } = await setup();
  const deps = { registry, credentials };
  const accepted = await receiveWebhook(deps, COMPANY_A, "whatsapp", signedWebhook(inboundForm()));
  const rejected = await receiveWebhook(deps, COMPANY_A, "whatsapp", signedWebhook(inboundForm(), { token: "wrong-token-value" }));
  for (const receipt of [accepted, rejected]) {
    const text = JSON.stringify(receipt);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes(ACCOUNT_SID), false);
  }
});

test("a credential never appears in a send result, even when the provider echoes it", async () => {
  const { registry, credentials } = await setup();
  const basic = Buffer.from(`${ACCOUNT_SID}:${TOKEN}`).toString("base64");

  const echoed = fakeHttp({
    status: 401,
    headers: {},
    body: JSON.stringify({ code: 20003, status: 401, message: `Authenticate failed for ${TOKEN} on ${ACCOUNT_SID}` }),
  });
  const r1 = await sendOutbound({ registry, credentials, http: echoed.http }, COMPANY_A, outbound());
  assert.equal(r1.status, "failed");
  assert.equal(JSON.stringify(r1).includes(TOKEN), false);
  assert.equal(JSON.stringify(r1).includes(ACCOUNT_SID), false);
  assert.equal(JSON.stringify(r1).includes(basic), false);

  const r2 = await sendOutbound(
    { registry, credentials, http: async () => { throw { kind: "network", message: `socket reset while sending with ${TOKEN}` }; } },
    COMPANY_A,
    outbound({ idempotencyKey: "msg-0002" }),
  );
  assert.equal(r2.status, "failed");
  assert.equal(JSON.stringify(r2).includes(TOKEN), false);

  const thrown = await sendOutbound(
    { registry, credentials, http: async () => { throw new Error(`bad ${TOKEN}`); } },
    COMPANY_A,
    outbound({ idempotencyKey: "msg-0003" }),
  );
  assert.equal(thrown.errorCode, "provider_exception");
  assert.equal(JSON.stringify(thrown).includes(TOKEN), false);
});

test("credential values are redacted from text, and validation errors name keys only", () => {
  assert.equal(redactSecrets(`a ${TOKEN} b`, { whatsapp_token: TOKEN }), "a [redacted] b");
  assert.equal(redactSecrets("ab cd", { x: "ab" }), "ab cd", "values under four characters are not redacted");

  assert.throws(
    () => validateCredentials({ whatsapp_token: 987654321 }),
    (error) => error.code === "CREDENTIALS_INVALID" && !error.message.includes("987654321"),
  );
  assert.throws(() => validateCredentials({ BadKey: "x" }), (error) => error.code === "CREDENTIALS_INVALID");
  assert.throws(() => validateCredentials([]), (error) => error.code === "CREDENTIALS_INVALID");
});

test("stored credentials are sealed, and a row copied to another company does not open", async () => {
  const secretBox = makeSecretBox();
  const storage = createMemoryChannelAccountStorage();
  const deps = { storage, secretBox };
  await saveChannelCredentials(deps, COMPANY_A, "whatsapp", ACCOUNT, CREDS);

  const sealed = await storage.findSealed(COMPANY_A, "whatsapp", ACCOUNT);
  const stored = JSON.stringify(sealed);
  assert.equal(stored.includes(TOKEN), false, "plaintext token is not stored");
  assert.equal(stored.includes(ACCOUNT_SID), false, "plaintext SID is not stored");

  const source = createChannelCredentialSource(deps);
  assert.deepEqual(await source.load(COMPANY_A, "whatsapp", ACCOUNT), CREDS);

  // Copy company A's sealed row under company B's key: decrypt must fail, so load returns null.
  await storage.saveSealed(COMPANY_B, "whatsapp", ACCOUNT, sealed);
  assert.equal(await source.load(COMPANY_B, "whatsapp", ACCOUNT), null);

  // A company with no row sees nothing.
  assert.equal(await source.load("00000000-0000-4000-8000-000000000000", "whatsapp", ACCOUNT), null);
});

test("a tampered sealed value fails closed", async () => {
  const secretBox = makeSecretBox();
  const storage = createMemoryChannelAccountStorage();
  await saveChannelCredentials({ storage, secretBox }, COMPANY_A, "whatsapp", ACCOUNT, CREDS);
  // The stored form is the versioned string "<keyVersion>:<iv>:<tag>:<ciphertext>", so tamper the ciphertext segment.
  const [keyId, iv, tag, ciphertext] = (await storage.findSealed(COMPANY_A, "whatsapp", ACCOUNT)).split(":");
  const flipped = Buffer.from(ciphertext, "base64");
  flipped[0] ^= 0xff;
  await storage.saveSealed(COMPANY_A, "whatsapp", ACCOUNT, [keyId, iv, tag, flipped.toString("base64")].join(":"));
  assert.equal(await createChannelCredentialSource({ storage, secretBox }).load(COMPANY_A, "whatsapp", ACCOUNT), null);
});

// ---------- outbound ----------

test("an outbound text posts the Twilio form with Basic auth through the injected client", async () => {
  const { registry, credentials } = await setup();
  const fake = fakeHttp(okTwilio());
  const result = await sendOutbound({ registry, credentials, http: fake.http }, COMPANY_A, outbound());

  assert.deepEqual(result, { status: "sent", externalMessageId: MESSAGE_SID });
  assert.equal(fake.calls.length, 1);
  const req = fake.calls[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
  assert.equal(req.timeoutMs, 10000);
  assert.equal(req.headers.Authorization, `Basic ${Buffer.from(`${ACCOUNT_SID}:${TOKEN}`).toString("base64")}`);
  const form = new URLSearchParams(req.body);
  assert.equal(form.get("To"), `whatsapp:${CUSTOMER}`);
  assert.equal(form.get("From"), `whatsapp:${ACCOUNT}`);
  assert.equal(form.get("Body"), "We are open 9 to 4 on Saturday.");
  assert.equal(form.get("StatusCallback"), WEBHOOK_URL);
});

test("a sandbox channel sends from the sandbox number", async () => {
  // A sandbox account is stored under the sandbox number, because that is the number Twilio delivers inbound to.
  const sandbox = { ...CREDS, whatsapp_environment: "sandbox", whatsapp_sandbox_phone: "+14155238886" };
  const { registry } = await setup({ creds: null });
  const credentials = { load: async () => sandbox };
  const fake = fakeHttp(okTwilio());
  await sendOutbound({ registry, credentials, http: fake.http }, COMPANY_A, outbound({ accountId: "+14155238886" }));
  assert.equal(new URLSearchParams(fake.calls[0].body).get("From"), "whatsapp:+14155238886");
});

test("a template send uses the registered content SID, and an unregistered name is refused before the network", async () => {
  const { registry, credentials } = await setup();
  const contentSid = "HX" + "abcdef0123456789".repeat(2);
  const fake = fakeHttp(okTwilio());
  const sent = await sendOutbound(
    { registry, credentials, http: fake.http },
    COMPANY_A,
    outbound({ contentKind: "template", text: null, templateName: contentSid, templateParams: { "1": "Dana" }, idempotencyKey: "tpl-1" }),
  );
  assert.equal(sent.status, "sent");
  const form = new URLSearchParams(fake.calls[0].body);
  assert.equal(form.get("ContentSid"), contentSid);
  assert.equal(form.get("ContentVariables"), JSON.stringify({ "1": "Dana" }));
  assert.equal(form.has("Body"), false);

  const refused = fakeHttp(okTwilio());
  const result = await sendOutbound(
    { registry, credentials, http: refused.http },
    COMPANY_A,
    outbound({ contentKind: "template", text: null, templateName: "welcome_v2", idempotencyKey: "tpl-2" }),
  );
  assert.equal(result.errorCode, "template_not_registered");
  assert.equal(refused.calls.length, 0);
});

test("an attachment must be an https URL, and media is sent as MediaUrl", async () => {
  const { registry, credentials } = await setup();
  const plain = fakeHttp(okTwilio());
  const refused = await sendOutbound(
    { registry, credentials, http: plain.http },
    COMPANY_A,
    outbound({ contentKind: "image", text: null, attachmentUrl: "http://files.example.test/a.jpg", idempotencyKey: "img-1" }),
  );
  assert.equal(refused.errorCode, "attachment_url_invalid");
  assert.equal(plain.calls.length, 0);

  const fake = fakeHttp(okTwilio());
  await sendOutbound(
    { registry, credentials, http: fake.http },
    COMPANY_A,
    outbound({ contentKind: "image", text: "Your quote", attachmentUrl: "https://files.example.test/a.jpg", idempotencyKey: "img-2" }),
  );
  const form = new URLSearchParams(fake.calls[0].body);
  assert.equal(form.get("MediaUrl"), "https://files.example.test/a.jpg");
  assert.equal(form.get("Body"), "Your quote");
});

test("provider errors map to retryable and non-retryable results", async () => {
  const { registry, credentials } = await setup();
  const cases = [
    { name: "429", response: { status: 429, headers: {}, body: "{}" }, errorCode: "http_429", retryable: true },
    { name: "500", response: { status: 500, headers: {}, body: "" }, errorCode: "http_500", retryable: true },
    { name: "21211", response: { status: 400, headers: {}, body: JSON.stringify({ code: 21211, message: "Invalid To number" }) }, errorCode: "twilio_21211", retryable: false },
    { name: "63016", response: { status: 400, headers: {}, body: JSON.stringify({ code: 63016, message: "Outside window" }) }, errorCode: "session_window_closed", retryable: false },
  ];
  let n = 0;
  for (const c of cases) {
    n += 1;
    const fake = fakeHttp(c.response);
    const result = await sendOutbound({ registry, credentials, http: fake.http }, COMPANY_A, outbound({ idempotencyKey: `err-${n}` }));
    assert.equal(result.status, "failed", c.name);
    assert.equal(result.errorCode, c.errorCode, c.name);
    assert.equal(result.retryable, c.retryable, c.name);
  }

  const network = await sendOutbound(
    { registry, credentials, http: async () => { throw { kind: "network", message: "refused" }; } },
    COMPANY_A,
    outbound({ idempotencyKey: "err-net" }),
  );
  assert.equal(network.retryable, true);
  const timeout = await sendOutbound(
    { registry, credentials, http: async () => { throw { kind: "timeout", message: "slow" }; } },
    COMPANY_A,
    outbound({ idempotencyKey: "err-timeout" }),
  );
  assert.equal(timeout.errorCode, "transport_timeout");
  assert.equal(timeout.retryable, false, "a timeout is ambiguous, so it is not retried");
});

test("the same idempotency key sends once", async () => {
  const { registry, credentials } = await setup();
  const fake = fakeHttp(okTwilio());
  const deps = { registry, credentials, http: fake.http };
  const first = await sendOutbound(deps, COMPANY_A, outbound({ idempotencyKey: "same-key" }));
  const second = await sendOutbound(deps, COMPANY_A, outbound({ idempotencyKey: "same-key" }));
  assert.deepEqual(second, first);
  assert.equal(fake.calls.length, 1);

  await sendOutbound(deps, COMPANY_A, outbound({ idempotencyKey: "other-key" }));
  assert.equal(fake.calls.length, 2);

  // The cache is keyed by company: company B with the same key sends its own message.
  const anyCompany = { load: async () => CREDS };
  const shared = fakeHttp(okTwilio());
  const sharedDeps = { registry, credentials: anyCompany, http: shared.http };
  await sendOutbound(sharedDeps, COMPANY_A, outbound({ idempotencyKey: "k-cross" }));
  await sendOutbound(sharedDeps, COMPANY_B, outbound({ idempotencyKey: "k-cross" }));
  assert.equal(shared.calls.length, 2);
});

test("sends that break a channel rule are refused before any network call", async () => {
  const { registry, credentials } = await setup();
  const fake = fakeHttp(okTwilio());
  const deps = { registry, credentials, http: fake.http };

  const tooLong = await sendOutbound(deps, COMPANY_A, outbound({ text: "x".repeat(1601), idempotencyKey: "long" }));
  assert.equal(tooLong.errorCode, "text_too_long");

  const wrongChannel = await sendOutbound(deps, COMPANY_A, outbound({ channel: "telegram", idempotencyKey: "mismatch" }));
  assert.equal(wrongChannel.errorCode, "kind_unknown");

  const noKey = await sendOutbound(deps, COMPANY_A, outbound({ idempotencyKey: "  " }));
  assert.equal(noKey.errorCode, "idempotency_key_missing");

  const badRecipient = await sendOutbound(deps, COMPANY_A, outbound({ recipient: "call me", idempotencyKey: "bad-to" }));
  assert.equal(badRecipient.errorCode, "recipient_invalid");

  const noCreds = await sendOutbound({ ...deps, credentials: { load: async () => null } }, COMPANY_A, outbound({ idempotencyKey: "nc" }));
  assert.equal(noCreds.errorCode, "credentials_missing");

  const empty = await sendOutbound(deps, COMPANY_A, outbound({ text: "", idempotencyKey: "empty" }));
  assert.equal(empty.errorCode, "empty_message");

  assert.equal(fake.calls.length, 0);
});

test("a non-WhatsApp kind in the registry is refused on send", async () => {
  const { registry, credentials } = await setup();
  const result = await sendOutbound({ registry, credentials, http: fakeHttp(okTwilio()).http }, COMPANY_A, outbound({ channel: "sms" }));
  assert.equal(result.errorCode, "kind_unknown");
});

test("normalisation accepts Twilio and WaId forms and rejects junk", () => {
  assert.equal(normaliseWhatsappAddress("whatsapp:+61 412 345 678"), "+61412345678");
  assert.equal(normaliseWhatsappAddress("61412345678"), "+61412345678");
  assert.equal(normaliseWhatsappAddress("0412345678"), null);
  assert.equal(normaliseWhatsappAddress("+0123"), null);
  assert.equal(normaliseWhatsappAddress(undefined), null);
});

// ---------- company scope in Drizzle SQL ----------

const dialect = new PgDialect();
const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });
const db = drizzle(pool);
after(() => pool.end());

test("the channel account queries filter and bind company_id", () => {
  const find = dialect.sqlToQuery(buildFindSealedQuery(db, COMPANY_A, "whatsapp", ACCOUNT).getSQL());
  assert.match(find.sql, /"company_id" = \$\d+/);
  assert.ok(find.params.includes(COMPANY_A));
  assert.ok(find.params.includes("whatsapp"));
  assert.ok(find.params.includes(ACCOUNT));
  assert.ok(!find.params.includes(COMPANY_B));

  const sealed = { v: 1, alg: "aes-256-gcm", keyId: "k", iv: "aa", tag: "bb", ciphertext: "cc" };
  const save = dialect.sqlToQuery(buildSaveSealedQuery(db, COMPANY_A, "whatsapp", ACCOUNT, sealed, RECEIVED).getSQL());
  assert.match(save.sql, /^insert into "chatbot_channel_accounts"/i);
  assert.ok(save.sql.includes('"company_id"'));
  assert.match(save.sql, /on conflict \("company_id", ?"kind", ?"account_id"\)/i, "conflict target includes company_id");
  assert.ok(save.params.includes(COMPANY_A));
});

// ---------- flag ----------

test("the WhatsApp channel flag is on only for the exact value true", () => {
  assert.equal(isWhatsappChannelEnabled({}), false, "default off");
  assert.equal(isWhatsappChannelEnabled({ [WHATSAPP_CHANNEL_FLAG]: "true" }), true);
  for (const value of ["1", "yes", "on", "TRUE", "True", ""]) {
    assert.equal(isWhatsappChannelEnabled({ [WHATSAPP_CHANNEL_FLAG]: value }), false, `value ${JSON.stringify(value)} is off`);
  }
});
