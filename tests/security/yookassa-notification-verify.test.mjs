// Security regression test: YooKassa webhook must re-verify payments with the API.
// Run: node --test tests/security/yookassa-notification-verify.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchVerifiedYookassaPayment,
  YookassaVerificationError,
} from '../../server/engines/payment/gateways/yookassa/notification-verify.ts';

const PID = '2a7d6c7e-000f-5000-9000-1a2b3c4d5e6f';
const creds = { shopId: 'test-shop', secretKey: 'test-secret-value' };
const paid = {
  id: PID,
  status: 'succeeded',
  paid: true,
  amount: { value: '10.00', currency: 'RUB' },
  metadata: { userId: 'user-1', type: 'credits', packageId: 'pkg-1', credits: '100' },
};

function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

test('re-fetches the payment from the API and returns the API view, not the body', async () => {
  const calls = [];
  const v = await fetchVerifiedYookassaPayment(PID, { ...creds, fetchImpl: fakeFetch(200, paid, calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.yookassa.ru/v3/payments/${PID}`);
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('test-shop:test-secret-value').toString('base64'));
  assert.equal(v.metadata.credits, '100');
  assert.deepEqual(v.amount, { value: '10.00', currency: 'RUB' });
});

test('fails closed when shop credentials are missing and never calls the API', async () => {
  const calls = [];
  await assert.rejects(
    fetchVerifiedYookassaPayment(PID, { shopId: null, secretKey: undefined, fetchImpl: fakeFetch(200, paid, calls) }),
    YookassaVerificationError
  );
  assert.equal(calls.length, 0);
});

test('rejects a forged notification for a payment YooKassa does not know (404)', async () => {
  await assert.rejects(
    fetchVerifiedYookassaPayment(PID, { ...creds, fetchImpl: fakeFetch(404, { type: 'error' }) }),
    (err) => err instanceof YookassaVerificationError && err.retriable === false
  );
});

test('rejects when the API reports the payment is not a paid success', async () => {
  const pending = { ...paid, status: 'pending', paid: false };
  await assert.rejects(fetchVerifiedYookassaPayment(PID, { ...creds, fetchImpl: fakeFetch(200, pending) }));
});

test('rejects when the API returns a different payment id', async () => {
  const other = { ...paid, id: '11111111-2222-3333-4444-555555555555' };
  await assert.rejects(fetchVerifiedYookassaPayment(PID, { ...creds, fetchImpl: fakeFetch(200, other) }));
});

test('rejects a malformed payment id before any network call', async () => {
  const calls = [];
  await assert.rejects(fetchVerifiedYookassaPayment('../admin', { ...creds, fetchImpl: fakeFetch(200, paid, calls) }));
  await assert.rejects(fetchVerifiedYookassaPayment(undefined, { ...creds, fetchImpl: fakeFetch(200, paid, calls) }));
  assert.equal(calls.length, 0);
});

test('marks YooKassa outages as retriable so the webhook can be redelivered', async () => {
  await assert.rejects(
    fetchVerifiedYookassaPayment(PID, { ...creds, fetchImpl: fakeFetch(503, {}) }),
    (err) => err instanceof YookassaVerificationError && err.retriable === true
  );
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(
    fetchVerifiedYookassaPayment(PID, { ...creds, fetchImpl: down }),
    (err) => err instanceof YookassaVerificationError && err.retriable === true
  );
});
