// Offline sandbox tests for the Razorpay webhook signature check
// (validateRazorpayWebhook in server/middleware/webhookValidation.ts).
// No network and no database: the storage module (which holds the webhook secret),
// the Stripe service and express types are replaced with in-memory stubs through a
// module resolve hook (data: URLs, no extra files). Real HMACs are computed with node:crypto.
// Run: node --test --experimental-transform-types tests/security/razorpay-sandbox.test.mjs
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

const STUB_STORAGE = `
export const storage = {
  getGlobalSetting: async (key) =>
    key === 'razorpay_webhook_secret' && globalThis.__rzpSandbox.secret !== null
      ? { key, value: globalThis.__rzpSandbox.secret }
      : null,
};
`;
const STUB_STRIPE = `export const getStripeClient = async () => null;`;
const STUB_EXPRESS = `export const Request = undefined, Response = undefined, NextFunction = undefined;`;

const HOOK_SOURCE = `
const STUBS = ${JSON.stringify({ storage: STUB_STORAGE, stripe: STUB_STRIPE, express: STUB_EXPRESS })};
const toUrl = (src) => 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'express') return { url: toUrl(STUBS.express), shortCircuit: true };
  if (specifier.startsWith('.') && /(^|\\/)storage$/.test(specifier)) return { url: toUrl(STUBS.storage), shortCircuit: true };
  if (specifier.startsWith('.') && /(^|\\/)stripe-service$/.test(specifier)) return { url: toUrl(STUBS.stripe), shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw err;
  }
}
`;
register('data:text/javascript;base64,' + Buffer.from(HOOK_SOURCE).toString('base64'), import.meta.url);

globalThis.__rzpSandbox = { secret: null };
const { validateRazorpayWebhook } = await import(
  new URL('../../server/middleware/webhookValidation.ts', import.meta.url).href
);

const SECRET = 'whsec_sandbox_test_secret';
const BODY = JSON.stringify({
  entity: 'event',
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_TEST123', amount: 49900, currency: 'INR' } } },
});

const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('hex');

function makeReq({ body, signature }) {
  const headers = {};
  if (signature !== undefined) headers['x-razorpay-signature'] = signature;
  const raw = Buffer.from(body);
  return { headers, rawBody: raw, body: JSON.parse(body) };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
  };
}

async function run(req) {
  const res = makeRes();
  let nextCalls = 0;
  let nextArg;
  await validateRazorpayWebhook(req, res, (arg) => { nextCalls += 1; nextArg = arg; });
  return { res, nextCalls, nextArg };
}

beforeEach(() => {
  globalThis.__rzpSandbox = { secret: SECRET };
});

test('tampered body is rejected even when the signature was made from the original body', async () => {
  const signature = sign(SECRET, BODY);
  const tampered = BODY.replace('49900', '1');
  assert.notEqual(tampered, BODY);

  const { res, nextCalls } = await run(makeReq({ body: tampered, signature }));

  assert.equal(nextCalls, 0, 'next() must not run for a tampered body');
  assert.equal(res.statusCode, 401);
});

test('missing signature header fails closed', async () => {
  const { res, nextCalls } = await run(makeReq({ body: BODY, signature: undefined }));

  assert.equal(nextCalls, 0, 'next() must not run without a signature header');
  assert.equal(res.statusCode, 401);
});

test('valid signature from the correct secret passes, and the wrong secret does not', async () => {
  const good = await run(makeReq({ body: BODY, signature: sign(SECRET, BODY) }));
  assert.equal(good.nextCalls, 1, 'next() must run once for a valid signature');
  assert.equal(good.nextArg, undefined, 'next() must be called without an error');
  assert.equal(good.res.statusCode, 200, 'response must not be rejected');

  const wrong = await run(makeReq({ body: BODY, signature: sign('whsec_other', BODY) }));
  assert.equal(wrong.nextCalls, 0, 'a signature made with a different secret must not pass');
  assert.equal(wrong.res.statusCode, 401);
});
