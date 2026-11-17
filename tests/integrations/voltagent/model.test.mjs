import assert from 'node:assert/strict';
import test from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createVoltAgentChatProvider } from '../../../server/integrations/voltagent/model/chat-provider.ts';
import { ProviderFailoverChain } from '../../../server/services/ai-runtime/failover.ts';
import { PROVIDER_NOT_CONFIGURED } from '../../../server/services/ai-runtime/contracts.ts';

// Inline fake. tests/integrations/voltagent/_helpers/ does not exist on voltagent/integration.
function okResult(text) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 2, text: 2, reasoning: undefined },
    },
    warnings: [],
  };
}

function fakeModel(modelId, behaviour) {
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId,
    doGenerate: async () => {
      if (behaviour.status !== undefined) {
        const err = new Error(`fake ${behaviour.status}`);
        err.statusCode = behaviour.status;
        throw err;
      }
      return okResult(behaviour.text ?? 'hello');
    },
  });
}

const request = { companyId: 'company-1', messages: [{ role: 'user', content: 'hi' }] };

test('refuses when unconfigured, with no I/O', async () => {
  const provider = createVoltAgentChatProvider({});
  assert.equal(provider.providerName(), 'disabled');
  const result = await provider.chat(request);
  assert.equal(result.ok, false);
  assert.equal(result.error, PROVIDER_NOT_CONFIGURED);
  assert.equal(result.retryable, false);
  assert.equal((await provider.health()).ok, false);
});

test('refuses a string model id instead of routing through the gateway', async () => {
  const provider = createVoltAgentChatProvider({ model: 'openai/gpt-4o' });
  const result = await provider.chat(request);
  assert.equal(result.ok, false);
  assert.equal(result.error, PROVIDER_NOT_CONFIGURED);
});

test('delegates a successful call to the model and maps the result', async () => {
  const model = fakeModel('fake-1', { text: 'answer' });
  const provider = createVoltAgentChatProvider({ model, providerName: 'voltagent-test' });
  const result = await provider.chat(request);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'voltagent-test');
  assert.equal(result.model, 'fake-1');
  assert.equal(result.content, 'answer');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0].prompt[0].role, 'user');
});

test('a 503 fails over to the next provider in the chain', async () => {
  const failing = fakeModel('bad', { status: 503 });
  const healthy = fakeModel('good', { text: 'from second' });
  const chain = new ProviderFailoverChain({
    chatProviders: [
      createVoltAgentChatProvider({ model: failing, providerName: 'first' }),
      createVoltAgentChatProvider({ model: healthy, providerName: 'second' }),
    ],
  });
  const result = await chain.chat(request);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'second');
  assert.equal(result.content, 'from second');
  assert.equal(failing.doGenerateCalls.length, 1, 'SDK retries are off, so one call per provider');
});

test('a 400 does NOT fail over', async () => {
  const badRequest = fakeModel('bad', { status: 400 });
  const healthy = fakeModel('good', { text: 'should not be reached' });
  const chain = new ProviderFailoverChain({
    chatProviders: [
      createVoltAgentChatProvider({ model: badRequest, providerName: 'first' }),
      createVoltAgentChatProvider({ model: healthy, providerName: 'second' }),
    ],
  });
  const result = await chain.chat(request);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'http_400');
  assert.equal(healthy.doGenerateCalls.length, 0);
});

test('an unknown status does NOT fail over', async () => {
  const teapot = fakeModel('odd', { status: 418 });
  const healthy = fakeModel('good', { text: 'should not be reached' });
  const chain = new ProviderFailoverChain({
    chatProviders: [
      createVoltAgentChatProvider({ model: teapot, providerName: 'first' }),
      createVoltAgentChatProvider({ model: healthy, providerName: 'second' }),
    ],
  });
  const result = await chain.chat(request);
  assert.equal(result.ok, false);
  assert.equal(result.status, 418);
  assert.equal(healthy.doGenerateCalls.length, 0);
});

test('a tool message is refused without calling the model', async () => {
  const model = fakeModel('fake-1', { text: 'x' });
  const provider = createVoltAgentChatProvider({ model });
  const result = await provider.chat({
    companyId: 'company-1',
    messages: [{ role: 'tool', content: 'result' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_message_role');
  assert.equal(result.retryable, false);
  assert.equal(model.doGenerateCalls.length, 0);
});
