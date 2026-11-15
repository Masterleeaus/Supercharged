/**
 * Claims checked for server/services/stripe-service.ts after the `any` cleanup:
 *   1. A string DB setting is used as the publishable key.
 *   2. A non-string DB setting (jsonb can hold anything) is treated as unset, so the env key is used.
 *   3. With no DB key and no env key, getStripeClient returns null.
 *
 * stripe-service imports storage and the logger. A resolve hook swaps both for stubs, so the
 * module loads without a database and makes no network call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const HOOK_SOURCE = `
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);

export async function resolve(specifier, context, nextResolve) {
  if (/(^|\\/)storage$/.test(specifier)) {
    return {
      url: DATA('export const storage = { getGlobalSetting: async (key) => globalThis.__stripeSettings?.[key] };'),
      shortCircuit: true,
    };
  }
  if (/(^|\\/)utils\\/logger$/.test(specifier)) {
    return {
      url: DATA('export const logger = { info() {}, warn() {}, error() {}, debug() {} };'),
      shortCircuit: true,
    };
  }
  if (/(^|\\/)utils\\/errors$/.test(specifier)) {
    return {
      url: DATA('export class PaymentError extends Error { constructor(provider, message) { super(message); this.provider = provider; } }'),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));

const { getStripePublicKey, getStripeClient } = await import('../../server/services/stripe-service.ts');

const savedEnv = {
  VITE_STRIPE_PUBLIC_KEY: process.env.VITE_STRIPE_PUBLIC_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  TESTING_STRIPE_SECRET_KEY: process.env.TESTING_STRIPE_SECRET_KEY,
};
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete globalThis.__stripeSettings;
});

function reset(settings, env = {}) {
  globalThis.__stripeSettings = settings;
  delete process.env.VITE_STRIPE_PUBLIC_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.TESTING_STRIPE_SECRET_KEY;
  Object.assign(process.env, env);
}

test('string DB publishable key is returned', async () => {
  reset({ stripe_publishable_key: { value: 'pk_test_from_db' } }, { VITE_STRIPE_PUBLIC_KEY: 'pk_test_env' });
  assert.equal(await getStripePublicKey(), 'pk_test_from_db');
});

test('non-string DB publishable key falls back to env', async () => {
  reset({ stripe_publishable_key: { value: 12345 } }, { VITE_STRIPE_PUBLIC_KEY: 'pk_test_env' });
  assert.equal(await getStripePublicKey(), 'pk_test_env');
});

test('no DB or env publishable key returns null', async () => {
  reset({ stripe_publishable_key: { value: { nested: true } } });
  assert.equal(await getStripePublicKey(), null);
});

test('non-string DB secret key with no env key yields no client', async () => {
  reset({ stripe_secret_key: { value: ['not', 'a', 'string'] } });
  assert.equal(await getStripeClient(), null);
});

test('non-string DB secret key uses the env secret key', async () => {
  // A dummy test-mode value. Stripe's constructor makes no network call.
  reset({ stripe_secret_key: { value: 42 } }, { STRIPE_SECRET_KEY: 'sk_test_dummy_for_unit_test' });
  const client = await getStripeClient();
  assert.notEqual(client, null);
});
