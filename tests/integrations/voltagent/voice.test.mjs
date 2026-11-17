import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceSpike } from '../../../server/integrations/voltagent/voice/spike.ts';

const fakeProvider = (overrides = {}) => ({
  transcribe: async () => 'hello',
  respond: async (co, sess, text) => `reply to ${text} for ${co}/${sess}`,
  synthesize: async () => new Uint8Array([1, 2, 3]),
  ...overrides,
});
const turn = { companyId: 'co-1', sessionId: 's-1', audio: new Uint8Array([9]) };

test('disabled spike refuses and never calls the provider', async () => {
  let called = false;
  const spike = createVoiceSpike({ enabled: false, provider: fakeProvider({ transcribe: async () => { called = true; return ''; } }) });
  assert.equal((await spike.handleTurn(turn)).code, 'voice_disabled');
  assert.equal(called, false);
});

test('enabled spike runs transcribe, respond and synthesize in order', async () => {
  const spike = createVoiceSpike({ enabled: true, provider: fakeProvider() });
  const out = await spike.handleTurn(turn);
  assert.equal(out.ok, true);
  assert.equal(out.reply.text, 'reply to hello for co-1/s-1');
  assert.deepEqual([...out.audio], [1, 2, 3]);
});

test('missing companyId is refused', async () => {
  const spike = createVoiceSpike({ enabled: true, provider: fakeProvider() });
  assert.equal((await spike.handleTurn({ ...turn, companyId: ' ' })).code, 'company_required');
});

test('empty or non-binary audio is refused', async () => {
  const spike = createVoiceSpike({ enabled: true, provider: fakeProvider() });
  assert.equal((await spike.handleTurn({ ...turn, audio: new Uint8Array(0) })).code, 'empty_audio');
  assert.equal((await spike.handleTurn({ ...turn, audio: 'abc' })).code, 'empty_audio');
});

test('a provider error becomes provider_failed', async () => {
  const spike = createVoiceSpike({ enabled: true, provider: fakeProvider({ respond: async () => { throw new Error('upstream down'); } }) });
  assert.deepEqual(await spike.handleTurn(turn), { ok: false, code: 'provider_failed', message: 'upstream down' });
});
