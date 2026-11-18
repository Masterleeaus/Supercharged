/**
 * W3 (#391): tests for the VoltAgent chat provider over a caller-built model object.
 * The model is a fake AI SDK v2 language model. No key, no network.
 * Run: node --test --experimental-transform-types tests/integrations/voltagent/chat-provider.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoltAgentChatProvider } from '../../../server/integrations/voltagent/model/chat-provider.ts';

const MSG = [{ role: 'user', content: 'hello' }];

function fakeModel({ text = 'hi there', fail = null } = {}) {
  const calls = [];
  return {
    calls,
    model: {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake-model-1',
      supportedUrls: {},
      async doGenerate(options) {
        calls.push(options);
        if (fail) throw fail;
        return {
          content: [{ type: 'text', text }],
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          warnings: [],
        };
      },
      async doStream() {
        throw new Error('streaming is not used by this adapter');
      },
    },
  };
}

test('no model, or a string model id, gives a disabled provider that refuses every call', async () => {
  for (const config of [undefined, {}, { model: null }, { model: 'openai/gpt-x' }]) {
    const provider = createVoltAgentChatProvider(config);
    const r = await provider.chat({ companyId: 'co-1', messages: MSG });
    assert.equal(r.ok, false, JSON.stringify(config));
  }
});

test('a configured model returns its text, usage and model id under the provider name', async () => {
  const { model } = fakeModel({ text: 'booked' });
  const provider = createVoltAgentChatProvider({ model, providerName: 'primary' });
  assert.equal(provider.providerName(), 'primary');
  const r = await provider.chat({ companyId: 'co-1', messages: MSG });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'primary');
  assert.equal(r.model, 'fake-model-1');
  assert.equal(r.content, 'booked');
  assert.deepEqual(r.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('the default provider name is voltagent', () => {
  const { model } = fakeModel();
  assert.equal(createVoltAgentChatProvider({ model }).providerName(), 'voltagent');
});

test('SDK retries are off, so the provider status reaches the failover chain unchanged', async () => {
  const fake = fakeModel({ fail: Object.assign(new Error('rate limited'), { statusCode: 429 }) });
  const r = await createVoltAgentChatProvider({ model: fake.model }).chat({ companyId: 'co-1', messages: MSG });
  assert.deepEqual([r.ok, r.error, r.status, r.retryable], [false, 'http_429', 429, true]);
  assert.equal(fake.calls.length, 1);
});

test('a thrown error without a status is a transport error and never leaks its message', async () => {
  const fake = fakeModel({ fail: new Error('secret-key-abc123 in response body') });
  const r = await createVoltAgentChatProvider({ model: fake.model }).chat({ companyId: 'co-1', messages: MSG });
  assert.equal(r.error, 'transport_error');
  assert.equal(r.status, null);
  assert.doesNotMatch(JSON.stringify(r), /secret-key/);
});

test('an empty message list and a tool message are refused before any model call', async () => {
  const fake = fakeModel();
  const provider = createVoltAgentChatProvider({ model: fake.model });
  assert.equal((await provider.chat({ companyId: 'co-1', messages: [] })).error, 'no_messages');
  const tool = await provider.chat({ companyId: 'co-1', messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(tool.error, 'unsupported_message_role');
  assert.equal(fake.calls.length, 0);
});

test('health is ok with no I/O when a model is configured', async () => {
  const fake = fakeModel();
  const h = await createVoltAgentChatProvider({ model: fake.model }).health();
  assert.deepEqual(h, { ok: true, provider: 'voltagent', reason: null });
  assert.equal(fake.calls.length, 0);
});
