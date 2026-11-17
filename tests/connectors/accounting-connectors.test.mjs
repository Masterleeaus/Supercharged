import test from 'node:test';
import assert from 'node:assert/strict';

const acc = await import('../../server/connectors/providers/accounting.ts');
const pay = await import('../../server/connectors/providers/payment-status.ts');
const sdk = await import('../../server/connectors/sdk/contract.ts');
const rec = await import('../../server/connectors/accounting/reconcile.ts');

const OAUTH = { type: 'oauth2', accessToken: 'token-value' };
const APIKEY = { type: 'api_key', apiKey: 'rk_test_read_only_key' };
const LINE = { description: 'Gutter clean', quantity: 2, unitAmount: 19.99, accountCode: '200', itemId: '7', taxType: 'OUTPUT' };
const INVOICE = { reference: 'inv-100', customerId: 'cust-1', date: '2026-11-18', currency: 'AUD', lines: [LINE] };

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const run = (def, action, input, credentials, extra = {}) =>
  def.execute({ action, input, timeoutMs: 1000, ...extra }, credentials);

test('every accounting and payment definition passes the SDK contract check and is invoice-scoped', () => {
  const { fetch } = fakeFetch(() => json({}));
  for (const def of [
    acc.createXeroConnector({ fetch }),
    acc.createMyobConnector({ fetch, myobApiKey: 'client' }),
    acc.createQuickBooksConnector({ fetch }),
    pay.createStripeStatusConnector({ fetch }),
    pay.createPaystackStatusConnector({ fetch }),
  ]) {
    assert.deepEqual(sdk.checkConnectorDefinition(def), [], def.id);
    assert.deepEqual(def.entities, ['invoice'], def.id);
  }
});

test('payment status connectors are read-only: no write capability and no write action', () => {
  const { fetch } = fakeFetch(() => json({}));
  for (const def of [pay.createStripeStatusConnector({ fetch }), pay.createPaystackStatusConnector({ fetch })]) {
    assert.deepEqual(def.capabilities, ['read'], def.id);
    assert.ok(Object.values(def.actions).every((a) => a.kind === 'read'), def.id);
  }
});

test('Xero pushes an ACCREC invoice once, sending the idempotency key and tenant header, and returns the vendor id', async () => {
  const { fetch, calls } = fakeFetch(() => json({ Invoices: [{ InvoiceID: 'xero-1' }] }));
  const def = acc.createXeroConnector({ fetch });
  const out = await run(def, 'createInvoice', { ...INVOICE, tenantId: 'tenant-9' }, OAUTH, { idempotencyKey: 'key-1' });
  assert.deepEqual(out, { vendorInvoiceId: 'xero-1' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.xero.com/api.xro/2.0/Invoices');
  assert.equal(init.headers['xero-tenant-id'], 'tenant-9');
  assert.equal(init.headers['idempotency-key'], 'key-1');
  const body = JSON.parse(init.body).Invoices[0];
  assert.equal(body.Type, 'ACCREC');
  assert.equal(body.Reference, 'inv-100');
  assert.equal(body.LineItems[0].UnitAmount, 19.99);
});

test('Xero payment status: PAID is paid, an authorised invoice with money due is not', async () => {
  let status = 'PAID';
  const { fetch } = fakeFetch(() => json({ Invoices: [{ Status: status, AmountDue: status === 'PAID' ? 0 : 39.98 }] }));
  const def = acc.createXeroConnector({ fetch });
  assert.deepEqual(await run(def, 'getInvoicePaymentStatus', { tenantId: 't', vendorInvoiceId: 'xero-1' }, OAUTH), { paid: true, amountDue: 0 });
  status = 'AUTHORISED';
  assert.deepEqual(await run(def, 'getInvoicePaymentStatus', { tenantId: 't', vendorInvoiceId: 'xero-1' }, OAUTH), { paid: false, amountDue: 39.98 });
});

test('MYOB reuses an invoice already pushed for the same reference instead of creating a second one', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('$filter')) return json({ Items: [{ UID: 'myob-existing' }] });
    throw new Error('should not create');
  });
  const def = acc.createMyobConnector({ fetch, myobApiKey: 'client' });
  const out = await run(def, 'createInvoice', { ...INVOICE, companyFileId: 'cf-1' }, OAUTH);
  assert.deepEqual(out, { vendorInvoiceId: 'myob-existing', reused: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-myobapi-key'], 'client');
});

test('MYOB creates an invoice when none exists and reads the new id from the Location header', async () => {
  const { fetch, calls } = fakeFetch((url, init) => {
    if (init.method === 'GET') return json({ Items: [] });
    return new Response(null, { status: 201, headers: { location: 'https://api.myob.com/accountright/cf-1/Sale/Invoice/Item/abc-123' } });
  });
  const def = acc.createMyobConnector({ fetch, myobApiKey: 'client' });
  assert.deepEqual(await run(def, 'createInvoice', { ...INVOICE, companyFileId: 'cf-1' }, OAUTH), { vendorInvoiceId: 'abc-123' });
  assert.equal(calls.length, 2);
});

test('MYOB payment status: zero balance due is paid', async () => {
  const { fetch } = fakeFetch(() => json({ BalanceDueAmount: 0 }));
  const def = acc.createMyobConnector({ fetch, myobApiKey: 'client' });
  assert.deepEqual(await run(def, 'getInvoicePaymentStatus', { companyFileId: 'cf-1', vendorInvoiceId: 'abc' }, OAUTH), { paid: true, amountDue: 0 });
});

test('QuickBooks sends the idempotency key as requestid and computes each line amount from quantity and unit price only', async () => {
  const { fetch, calls } = fakeFetch(() => json({ Invoice: { Id: 'qb-7' } }));
  const def = acc.createQuickBooksConnector({ fetch });
  const out = await run(def, 'createInvoice', { ...INVOICE, realmId: 'realm-1' }, OAUTH, { idempotencyKey: 'key-2' });
  assert.deepEqual(out, { vendorInvoiceId: 'qb-7' });
  assert.match(calls[0].url, /\/v3\/company\/realm-1\/invoice\?minorversion=65&requestid=key-2$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.Line[0].Amount, 39.98);
  assert.equal(body.Line[0].SalesItemLineDetail.ItemRef.value, '7');
});

test('QuickBooks payment status: zero balance is paid', async () => {
  const { fetch } = fakeFetch(() => json({ Invoice: { Balance: 0 } }));
  const def = acc.createQuickBooksConnector({ fetch });
  assert.deepEqual(await run(def, 'getInvoicePaymentStatus', { realmId: 'r', vendorInvoiceId: '7' }, OAUTH), { paid: true, amountDue: 0 });
});

test('invoice input is refused when the reference, currency, amounts or lines are bad', async () => {
  const { fetch, calls } = fakeFetch(() => json({}));
  const def = acc.createXeroConnector({ fetch });
  const base = { ...INVOICE, tenantId: 't' };
  await assert.rejects(() => run(def, 'createInvoice', { ...base, reference: "x' or 1=1" }, OAUTH), (e) => e.code === 'validation');
  await assert.rejects(() => run(def, 'createInvoice', { ...base, currency: 'aud' }, OAUTH), (e) => e.code === 'validation');
  await assert.rejects(() => run(def, 'createInvoice', { ...base, lines: [{ ...LINE, unitAmount: 19.999 }] }, OAUTH), (e) => e.code === 'validation');
  await assert.rejects(() => run(def, 'createInvoice', { ...base, lines: [] }, OAUTH), (e) => e.code === 'validation');
  assert.equal(calls.length, 0);
});

test('a vendor 401 becomes an auth failure with no body text in the message', async () => {
  const { fetch } = fakeFetch(() => json({ Detail: 'token token-value is bad' }, 401));
  const def = acc.createXeroConnector({ fetch });
  await assert.rejects(() => run(def, 'getInvoicePaymentStatus', { tenantId: 't', vendorInvoiceId: 'x' }, OAUTH), (e) => {
    assert.equal(e.code, 'auth');
    assert.ok(!e.message.includes('token-value'));
    return true;
  });
});

test('Stripe status maps a succeeded payment intent to paid and never calls a write endpoint', async () => {
  const { fetch, calls } = fakeFetch(() => json({ status: 'succeeded' }));
  const def = pay.createStripeStatusConnector({ fetch });
  assert.deepEqual(await run(def, 'getPaymentStatus', { paymentIntentId: 'pi_123ABC' }, APIKEY), { status: 'paid', paid: true });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/payment_intents/pi_123ABC');
});

test('Stripe status rejects an id that is not a payment intent id', async () => {
  const { fetch, calls } = fakeFetch(() => json({}));
  const def = pay.createStripeStatusConnector({ fetch });
  await assert.rejects(() => run(def, 'getPaymentStatus', { paymentIntentId: 'ch_123' }, APIKEY), (e) => e.code === 'validation');
  assert.equal(calls.length, 0);
});

test('Paystack status maps a success to paid and refuses an OAuth credential', async () => {
  const { fetch } = fakeFetch(() => json({ data: { status: 'success' } }));
  const def = pay.createPaystackStatusConnector({ fetch });
  assert.deepEqual(await run(def, 'getPaymentStatus', { reference: 'ref_1-A' }, APIKEY), { status: 'paid', paid: true });
  await assert.rejects(() => run(def, 'getPaymentStatus', { reference: 'ref_1' }, OAUTH), (e) => e.code === 'auth');
});

test('reconcile counts paid, unpaid, missing and duplicate invoices', () => {
  const pushed = [
    { invoiceId: 'a', vendorInvoiceId: 'v1' },
    { invoiceId: 'b', vendorInvoiceId: 'v2' },
    { invoiceId: 'c', vendorInvoiceId: 'v3' },
    { invoiceId: 'd', vendorInvoiceId: 'v4' },
    { invoiceId: 'd', vendorInvoiceId: 'v5' },
  ];
  const status = new Map([['v1', { paid: true, amountDue: 0 }], ['v2', { paid: false, amountDue: 40 }]]);
  const report = rec.reconcile(pushed, status);
  assert.deepEqual(report.totals, { pushed: 5, paid: 1, unpaid: 1, notFound: 1, duplicate: 2 });
  assert.equal(report.rows.find((r) => r.invoiceId === 'c').status, 'not_found');
});
