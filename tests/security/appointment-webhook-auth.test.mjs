// Security regression test: appointment webhook auth uses a header, not a URL secret.
// Uses fake values only. Run: node --test --experimental-transform-types tests/security/appointment-webhook-auth.test.mjs
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

const FAKE_SECRET = 'fake-appointment-secret-for-tests-0001';
process.env.APPOINTMENT_WEBHOOK_SECRET = FAKE_SECRET;
process.env.NODE_ENV = 'test';

const svc = await import('../../server/services/appointment-elevenlabs-tool.ts');
const {
  APPOINTMENT_WEBHOOK_SECRET_HEADER,
  appointmentReplayKey,
  appointmentTokenMatches,
  authenticateAppointmentRequest,
  getAppointmentToolForAgent,
  getBookAppointmentWebhookTool,
} = svc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

test('generated tool URL contains no secret and no path token', () => {
  for (const tool of [
    getAppointmentToolForAgent('el_agent_12345678'),
    getBookAppointmentWebhookTool('db-agent-id-87654321', 'call-1'),
  ]) {
    assert.ok(!tool.api_schema.url.includes(FAKE_SECRET), 'secret leaked into URL');
    assert.ok(!tool.api_schema.url.includes('DEV-ONLY'), 'dev secret leaked into URL');
    assert.match(tool.api_schema.url, /\/api\/webhooks\/elevenlabs\/appointment\/[^/?]+(\?|$)/);
  }
});

test('generated tool carries the secret only in the auth header', () => {
  const tool = getAppointmentToolForAgent('el_agent_12345678');
  assert.equal(tool.api_schema.headers[APPOINTMENT_WEBHOOK_SECRET_HEADER], FAKE_SECRET);
});

test('header token with the correct secret authenticates', () => {
  assert.deepEqual(
    authenticateAppointmentRequest({ headerToken: FAKE_SECRET }, FAKE_SECRET, {}),
    { ok: true, via: 'header' },
  );
});

test('forged header token is rejected', () => {
  assert.equal(authenticateAppointmentRequest({ headerToken: 'forged-value-of-same-length-xxxxxx' }, FAKE_SECRET, {}).ok, false);
  assert.equal(authenticateAppointmentRequest({ headerToken: 'x' }, FAKE_SECRET, {}).ok, false);
});

test('no header and no path token is rejected', () => {
  assert.deepEqual(authenticateAppointmentRequest({}, FAKE_SECRET, {}), { ok: false, via: null });
});

test('a valid path token is ignored when a wrong header is also sent', () => {
  const r = authenticateAppointmentRequest({ headerToken: 'wrong', pathToken: FAKE_SECRET }, FAKE_SECRET, {});
  assert.equal(r.ok, false);
  assert.equal(r.via, 'header');
});

test('legacy URL token is refused by default (off unless explicitly enabled)', () => {
  assert.deepEqual(
    authenticateAppointmentRequest({ pathToken: FAKE_SECRET }, FAKE_SECRET, {}),
    { ok: false, via: null },
  );
  assert.equal(svc.isLegacyAppointmentUrlTokenAllowed({}), false);
  assert.equal(svc.isLegacyAppointmentUrlTokenAllowed({ APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN: 'false' }), false);
  assert.equal(svc.isLegacyAppointmentUrlTokenAllowed({ APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN: 'TRUE' }), false);
});

test('legacy URL token works only when APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN is exactly "true"', () => {
  const env = { APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN: 'true' };
  assert.deepEqual(
    authenticateAppointmentRequest({ pathToken: FAKE_SECRET }, FAKE_SECRET, env),
    { ok: true, via: 'url' },
  );
  assert.equal(authenticateAppointmentRequest({ pathToken: 'wrong' }, FAKE_SECRET, env).ok, false);
  assert.equal(authenticateAppointmentRequest({ headerToken: FAKE_SECRET }, FAKE_SECRET, env).ok, true);
});

test('timing-safe matcher rejects empty, wrong-length and wrong values', () => {
  assert.equal(appointmentTokenMatches(undefined, FAKE_SECRET), false);
  assert.equal(appointmentTokenMatches('', FAKE_SECRET), false);
  assert.equal(appointmentTokenMatches(FAKE_SECRET + 'x', FAKE_SECRET), false);
  assert.equal(appointmentTokenMatches('a'.repeat(FAKE_SECRET.length), FAKE_SECRET), false);
  assert.equal(appointmentTokenMatches(FAKE_SECRET, FAKE_SECRET), true);
  assert.equal(appointmentTokenMatches(FAKE_SECRET, ''), false);
});

const base = { companyId: 'co-1', conversationId: 'conv-1', date: '2030-01-05', time: '10:00', phone: '+61 400 000 000' };

test('replay key is stable for a retried identical request', () => {
  assert.equal(appointmentReplayKey(base), appointmentReplayKey({ ...base }));
});

test('replay key differs for another company, conversation, slot or phone', () => {
  const k = appointmentReplayKey(base);
  assert.notEqual(k, appointmentReplayKey({ ...base, companyId: 'co-2' }));
  assert.notEqual(k, appointmentReplayKey({ ...base, conversationId: 'conv-2' }));
  assert.notEqual(k, appointmentReplayKey({ ...base, time: '11:00' }));
  assert.notEqual(k, appointmentReplayKey({ ...base, phone: '+61 400 000 001' }));
});

test('replay key ignores phone formatting only', () => {
  assert.equal(appointmentReplayKey(base), appointmentReplayKey({ ...base, phone: '+61400000000' }));
});

test('route wiring: header route is registered and the legacy route is gated', () => {
  const routes = read('server/routes/core/provider-webhook-routes.ts');
  assert.match(routes, /"\/api\/webhooks\/elevenlabs\/appointment\/:agentId"/);
  assert.match(routes, /"\/api\/webhooks\/elevenlabs\/appointment\/:token\/:agentId"/);
});

test('route wiring: replay check runs before the appointment insert and the cross-company guard exists', () => {
  const handler = read('server/routes/webhook-modules/appointment-tool-webhook.ts');
  const replayAt = handler.indexOf('appointmentReplayKey({');
  const insertAt = handler.indexOf('.insert(appointments)');
  assert.ok(replayAt > 0 && insertAt > replayAt, 'replay check must precede insert');
  assert.match(handler, /Refusing cross-company call link/);
});

// Log redaction for legacy token paths (issue #343). The token segment is replaced before any access log line.
const { redactWebhookTokenPath } = await import('../../server/utils/redact-webhook-path.ts');

test('legacy appointment URL-token path is redacted in logs', () => {
  const out = redactWebhookTokenPath(`/api/webhooks/elevenlabs/appointment/${FAKE_SECRET}/el_agent_1?callId=c1`);
  assert.equal(out, '/api/webhooks/elevenlabs/appointment/[redacted]/el_agent_1');
  assert.ok(!out.includes(FAKE_SECRET));
});

test('other token-bearing webhook paths are redacted', () => {
  assert.equal(redactWebhookTokenPath('/api/webhooks/elevenlabs/rag-tool/SECRET/agent'), '/api/webhooks/elevenlabs/rag-tool/[redacted]/agent');
  assert.equal(redactWebhookTokenPath('/api/webhooks/elevenlabs/form/SECRET/form-1/agent'), '/api/webhooks/elevenlabs/form/[redacted]/form-1/agent');
  assert.equal(redactWebhookTokenPath('/api/elevenlabs/tools/play-audio/SECRET/agent'), '/api/elevenlabs/tools/play-audio/[redacted]/agent');
});

test('header-auth and single-segment paths are left unchanged', () => {
  assert.equal(redactWebhookTokenPath('/api/webhooks/elevenlabs/appointment/el_agent_1'), '/api/webhooks/elevenlabs/appointment/el_agent_1');
  assert.equal(redactWebhookTokenPath('/api/webhooks/elevenlabs/rag-tool/agent'), '/api/webhooks/elevenlabs/rag-tool/agent');
  assert.equal(redactWebhookTokenPath('/api/plivo/voice/status'), '/api/plivo/voice/status');
});
