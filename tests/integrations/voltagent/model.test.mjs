// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FAILOVER_STATUSES, ProviderFailoverChain } from '../../../server/services/ai-runtime/failover.ts';
import { DisabledChatProvider } from '../../../server/services/ai-runtime/contracts.ts';
import { createVoltModelAdapter, ModelUnavailableError } from '../../../server/integrations/voltagent/model/adapter.ts';

const MSG = [{ role: 'user', content: 'hello' }];

function provider(name, respond) {
  const calls = [];
  return {
    calls,
    providerName: () => name,
    async chat(input) {
      calls.push(input);
      if (respond instanceof Error) throw respond;
      return respond(input);
    },
    async health() { return { ok: true, provider: name, reason: null }; },
  };
}

const ok = (provider) => ({ ok: true, provider, model: 'm1', content: 'answer', usage: { total_tokens: 3 }, latency_ms: 5 });
const fail = (provider, status, retryable = true) => ({ ok: false, provider, error: `http_${status}`, status, retryable, latency_ms: 2 });

function adapterFor(providers, companyId = 7) {
  const chain = new ProviderFailoverChain({ chatProviders: providers });
  return createVoltModelAdapter({ chain, companyId });
}

test('default failover statuses are the chain statuses 429, 500, 502, 503, 504', () => {
  assert.deepEqual([...DEFAULT_FAILOVER_STATUSES], [429, 500, 502, 503, 504]);
});

test('a successful call returns text, provider, model, usage and latency', async () => {
  const a = provider('p1', () => ok('p1'));
  const out = await adapterFor([a]).generate(MSG);
  assert.deepEqual(out, { text: 'answer', provider: 'p1', model: 'm1', usage: { total_tokens: 3 }, latencyMs: 5 });
  assert.equal(a.calls[0].companyId, '7');
  assert.deepEqual(a.calls[0].messages, MSG);
});

for (const status of [429, 500, 502, 503, 504]) {
  test(`status ${status} fails over to the next provider`, async () => {
    const first = provider('p1', () => fail('p1', status));
    const second = provider('p2', () => ok('p2'));
    const out = await adapterFor([first, second]).generate(MSG);
    assert.equal(out.provider, 'p2');
    assert.equal(second.calls.length, 1);
  });
}

test('a transport failure (provider throws) fails over', async () => {
  const first = provider('p1', new Error('socket reset'));
  const second = provider('p2', () => ok('p2'));
  const out = await adapterFor([first, second]).generate(MSG);
  assert.equal(out.provider, 'p2');
});

test('a non-failover status such as 400 or 401 stops the chain and throws with that status', async () => {
  for (const status of [400, 401]) {
    const first = provider('p1', () => fail('p1', status));
    const second = provider('p2', () => ok('p2'));
    await assert.rejects(
      () => adapterFor([first, second]).generate(MSG),
      (err) => err instanceof ModelUnavailableError && err.status === status && err.provider === 'p1',
    );
    assert.equal(second.calls.length, 0);
  }
});

test('retryable false stops failover even on a failover status', async () => {
  const first = provider('p1', () => fail('p1', 503, false));
  const second = provider('p2', () => ok('p2'));
  await assert.rejects(() => adapterFor([first, second]).generate(MSG), ModelUnavailableError);
  assert.equal(second.calls.length, 0);
});

test('fails closed when no provider is configured', async () => {
  await assert.rejects(
    () => adapterFor([]).generate(MSG),
    (err) => err instanceof ModelUnavailableError && err.code === 'no_chat_providers_configured' && err.status === null,
  );
});

test('a disabled provider refuses and the adapter throws, never returning an empty answer', async () => {
  const chain = new ProviderFailoverChain({ chatProviders: [new DisabledChatProvider()] });
  const adapter = createVoltModelAdapter({ chain, companyId: 7 });
  await assert.rejects(() => adapter.generate(MSG), (err) => err instanceof ModelUnavailableError && err.code === 'provider_not_configured');
});

test('a missing chain throws when the adapter is built', () => {
  assert.throws(() => createVoltModelAdapter({ chain: undefined, companyId: 7 }), /model_chain_required/);
});

test('a missing company id throws when the adapter is built', () => {
  const chain = new ProviderFailoverChain({ chatProviders: [provider('p1', () => ok('p1'))] });
  assert.throws(() => createVoltModelAdapter({ chain, companyId: undefined }), /companyId is required/);
});

test('an unknown role or bad message shape is rejected before any provider call', async () => {
  const a = provider('p1', () => ok('p1'));
  const adapter = adapterFor([a]);
  await assert.rejects(() => adapter.generate([{ role: 'developer', content: 'x' }]), /model_message_role_invalid/);
  await assert.rejects(() => adapter.generate([{ role: 'user', content: 5 }]), /model_message_content_invalid/);
  await assert.rejects(() => adapter.generate([]), /model_messages_required/);
  assert.equal(a.calls.length, 0);
});
