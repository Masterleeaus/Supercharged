// Secret reference tests (node:test). No network, no database. The resolver is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretRefs, SecretRefError, INTEGRATIONS } from '../../server/modules/comms/secret-refs.ts';

const CO_A = '6f1c2b3a-1111-4a2b-9c3d-0123456789ab';
const CO_B = '7a2d3c4b-2222-4b3c-8d4e-9876543210ba';
const FAKE_VALUE = 'FAKE-VALUE-DO-NOT-USE-7731';

const makeFake = (table = {}) => {
  const calls = [];
  const resolve = async (companyId, integration, name) => {
    calls.push({ companyId, integration, name });
    return table[`${companyId}|${integration}|${name}`];
  };
  return { resolve, calls };
};

test('a valid ref resolves to the stored value', async () => {
  const { resolve } = makeFake({ [`${CO_A}|telegram|bot_token`]: FAKE_VALUE });
  const refs = createSecretRefs({ resolve });
  const ref = refs.ref(CO_A, 'telegram', 'bot_token');
  assert.deepEqual(await refs.get(ref), { ok: true, value: FAKE_VALUE });
});

test('the resolver is called with the company, integration and name of the ref', async () => {
  const { resolve, calls } = makeFake();
  const refs = createSecretRefs({ resolve });
  await refs.get(refs.ref(CO_A, 'meta_app', 'app_secret'));
  assert.deepEqual(calls, [{ companyId: CO_A, integration: 'meta_app', name: 'app_secret' }]);
});

test("another company's ref passes that company's id, not the other one", async () => {
  const { resolve, calls } = makeFake();
  const refs = createSecretRefs({ resolve });
  const refA = refs.ref(CO_A, 'email_provider', 'api_key');
  const refB = refs.ref(CO_B, 'email_provider', 'api_key');
  await refs.get(refA);
  await refs.get(refB);
  assert.equal(calls[0].companyId, CO_A);
  assert.equal(calls[1].companyId, CO_B);
  assert.notEqual(calls[0].companyId, calls[1].companyId);
});

test('a foreign object with the same fields is refused without calling the resolver', async () => {
  const { resolve, calls } = makeFake({ [`${CO_A}|sms_provider|sid`]: FAKE_VALUE });
  const refs = createSecretRefs({ resolve });
  const forged = { companyId: CO_A, integration: 'sms_provider', name: 'sid' };
  assert.deepEqual(await refs.get(forged), { ok: false, reason: 'foreign_ref' });
  assert.equal(calls.length, 0);
});

test('a ref made by a different createSecretRefs instance is refused', async () => {
  const one = createSecretRefs({ resolve: makeFake().resolve });
  const two = createSecretRefs({ resolve: makeFake().resolve });
  assert.deepEqual(await two.get(one.ref(CO_A, 'telegram', 'bot_token')), { ok: false, reason: 'foreign_ref' });
});

test('non-object inputs to get are refused as foreign', async () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  for (const bad of [undefined, null, 'x', 42]) {
    assert.deepEqual(await refs.get(bad), { ok: false, reason: 'foreign_ref' });
  }
});

test('an unknown credential returns not_found', async () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  assert.deepEqual(await refs.get(refs.ref(CO_A, 'whatsapp', 'token')), { ok: false, reason: 'not_found' });
});

test('invalid company id is refused', () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  for (const bad of ['', 'not-a-uuid', '6f1c2b3a-1111-4a2b-9c3d-0123456789a', 12, null, undefined]) {
    assert.throws(() => refs.ref(bad, 'telegram', 'bot_token'), (e) => e instanceof SecretRefError && e.code === 'invalid_company');
  }
});

test('invalid integration is refused', () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  for (const bad of ['slack', 'Telegram', '', 'sms', undefined]) {
    assert.throws(() => refs.ref(CO_A, bad, 'bot_token'), (e) => e instanceof SecretRefError && e.code === 'invalid_integration');
  }
});

test('every listed integration is accepted', () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  assert.equal(INTEGRATIONS.length, 7);
  for (const integration of INTEGRATIONS) {
    assert.doesNotThrow(() => refs.ref(CO_A, integration, 'token'));
  }
});

test('invalid name is refused', () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  for (const bad of ['', 'Bot_Token', 'token1', 'bot-token', 'a'.repeat(41), 'bot token', undefined]) {
    assert.throws(() => refs.ref(CO_A, 'telegram', bad), (e) => e instanceof SecretRefError && e.code === 'invalid_name');
  }
  assert.doesNotThrow(() => refs.ref(CO_A, 'telegram', 'a'.repeat(40)));
});

test('describe returns a safe label and never the value', async () => {
  const { resolve } = makeFake({ [`${CO_A}|telegram|bot_token`]: FAKE_VALUE });
  const refs = createSecretRefs({ resolve });
  const ref = refs.ref(CO_A, 'telegram', 'bot_token');
  const label = refs.describe(ref);
  assert.equal(label, `company:${CO_A} integration:telegram.bot_token`);
  assert.ok(!label.includes(FAKE_VALUE));
});

test('describe refuses a foreign object without leaking anything', () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  assert.equal(refs.describe({ companyId: CO_A, integration: 'telegram', name: 'bot_token' }), 'foreign_ref');
});

test('JSON of a ref contains exactly the identity fields and no value', async () => {
  const { resolve } = makeFake({ [`${CO_A}|telegram|bot_token`]: FAKE_VALUE });
  const refs = createSecretRefs({ resolve });
  const ref = refs.ref(CO_A, 'telegram', 'bot_token');
  const json = JSON.stringify(ref);
  assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['companyId', 'integration', 'name']);
  assert.ok(!json.includes(FAKE_VALUE));
  assert.ok(!('value' in ref));
});

test('a ref is frozen so callers cannot attach a value to it', () => {
  const refs = createSecretRefs({ resolve: makeFake().resolve });
  const ref = refs.ref(CO_A, 'telegram', 'bot_token');
  assert.ok(Object.isFrozen(ref));
  assert.throws(() => { ref.value = FAKE_VALUE; }, TypeError);
  assert.equal(ref.value, undefined);
});

test('createSecretRefs requires a resolve function', () => {
  assert.throws(() => createSecretRefs({ resolve: 'nope' }), TypeError);
});
