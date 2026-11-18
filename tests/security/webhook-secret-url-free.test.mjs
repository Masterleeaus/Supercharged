// Security regression test: no appointment-family webhook URL carries the shared secret (issue #343).
// Uses fake values only. Run: node --test --experimental-transform-types tests/security/webhook-secret-url-free.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

console.log = () => {};
console.info = () => {};
console.warn = () => {};

const RESOLVE_HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
    for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
      const url = new URL(candidate, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(RESOLVE_HOOK), import.meta.url);

const FAKE_SECRET = 'fake-appointment-secret-for-tests-0002';
process.env.APPOINTMENT_WEBHOOK_SECRET = FAKE_SECRET;
process.env.NODE_ENV = 'test';
delete process.env.APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN;

const { APPOINTMENT_WEBHOOK_SECRET_HEADER, authenticateAppointmentRequest } = await import('../../server/services/appointment-elevenlabs-tool.ts');
const { getPlayAudioWebhookTool } = await import('../../server/services/play-audio-elevenlabs-tool.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

test('play-audio tool URL contains no secret and the secret is in the header', () => {
  const tool = getPlayAudioWebhookTool('node-abcdefgh', 'https://example.test/a.mp3', 'a.mp3', false, true, 'el_agent_12345678');
  assert.ok(!tool.api_schema.url.includes(FAKE_SECRET), 'secret leaked into play-audio URL');
  assert.equal(tool.api_schema.url.endsWith('/api/elevenlabs/tools/play-audio/el_agent_12345678'), true);
  assert.equal(tool.api_schema.headers[APPOINTMENT_WEBHOOK_SECRET_HEADER], FAKE_SECRET);
});

test('messaging tool builders take the secret out of their URLs', () => {
  for (const rel of ['server/services/elevenlabs.ts', 'server/services/openai-voice-agent/hydrator.ts']) {
    const src = read(rel);
    assert.ok(!/webhooks\/messaging\/[a-z-]+\/\$\{secret\}/.test(src), `${rel} still puts the secret in a messaging URL`);
  }
  const el = read('server/services/elevenlabs.ts');
  const headerUses = el.match(/\[APPOINTMENT_WEBHOOK_SECRET_HEADER\]: secret/g) || [];
  assert.equal(headerUses.length, 3, 'all three messaging tools must send the secret in the header');
});

test('header-first authentication: missing, wrong and right header', () => {
  assert.equal(authenticateAppointmentRequest({ headerToken: undefined, pathToken: undefined }, FAKE_SECRET, {}).ok, false);
  assert.equal(authenticateAppointmentRequest({ headerToken: 'wrong-value-of-same-length-xx', pathToken: undefined }, FAKE_SECRET, {}).ok, false);
  assert.equal(authenticateAppointmentRequest({ headerToken: FAKE_SECRET, pathToken: undefined }, FAKE_SECRET, {}).ok, true);
});

test('URL token is refused when the legacy flag is off, even when correct', () => {
  assert.equal(authenticateAppointmentRequest({ headerToken: undefined, pathToken: FAKE_SECRET }, FAKE_SECRET, {}).ok, false);
  assert.equal(authenticateAppointmentRequest({ headerToken: undefined, pathToken: FAKE_SECRET }, FAKE_SECRET, { APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN: 'true' }).ok, true);
});

test('a request with a wrong header is refused even if the URL token is correct and the flag is on', () => {
  assert.equal(
    authenticateAppointmentRequest({ headerToken: 'not-the-secret-value-xxxxxxxxxxxx', pathToken: FAKE_SECRET }, FAKE_SECRET, { APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN: 'true' }).ok,
    false,
  );
});
