// Security regression test: the play-audio ElevenLabs tool carries the appointment secret in a header, not the URL (issue #343).
// Static text test. Run: node --test --experimental-transform-types tests/security/play-audio-secret.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const ROUTES = 'server/routes/core/provider-webhook-routes.ts';
const PLAY_AUDIO = 'server/services/play-audio-elevenlabs-tool.ts';
const HEADER_ROUTE = 'app.post("/api/elevenlabs/tools/play-audio/:agentId", playAudioAuthorize, handlePlayAudioToolWebhook)';
const LEGACY_ROUTE = 'app.post("/api/elevenlabs/tools/play-audio/:token/:agentId", playAudioAuthorize, handlePlayAudioToolWebhook)';

test('play-audio header route exists and runs the shared authorizer before the handler', () => {
  const src = read(ROUTES);
  assert.ok(src.includes(HEADER_ROUTE), 'header-only play-audio route must be registered');
  const authz = src.indexOf('const playAudioAuthorize');
  assert.ok(authz >= 0, 'play-audio authorizer must be defined');
  const body = src.slice(authz, authz + 400);
  assert.match(body, /isAppointmentToolAuthorized\(req\)/);
  assert.match(body, /res\.status\(401\)/, 'unauthorized requests must get 401');
});

test('legacy token path route stays behind the same authorizer (flag-gated)', () => {
  const src = read(ROUTES);
  assert.ok(src.includes(LEGACY_ROUTE), 'legacy token route must use the same authorizer');
  assert.match(src, /authenticateAppointmentRequest\(/);
  assert.match(src, /headerToken: req\.get\(APPOINTMENT_WEBHOOK_SECRET_HEADER\)/);
});

test('provider webhook module imports the header name and the header-first authenticator', () => {
  assert.match(read(ROUTES),
    /import\s*\{[^}]*APPOINTMENT_WEBHOOK_SECRET_HEADER[^}]*authenticateAppointmentRequest[^}]*\}\s*from\s*"\.\.\/\.\.\/services\/appointment-elevenlabs-tool"/);
});

test('play-audio tool sends the secret in the header and never in the URL', () => {
  const src = read(PLAY_AUDIO);
  assert.match(src, /import\s*\{\s*APPOINTMENT_WEBHOOK_SECRET_HEADER,\s*getAppointmentWebhookSecret\s*\}\s*from\s*'\.\/appointment-elevenlabs-tool'/);
  assert.match(src, /const webhookUrl = `\$\{domain\}\/api\/elevenlabs\/tools\/play-audio\/\$\{elevenLabsAgentId\}`;/);
  assert.match(src, /\[APPOINTMENT_WEBHOOK_SECRET_HEADER\]: secret/);
  assert.ok(!/encodeURIComponent\(secret\)/.test(src), 'secret must not be interpolated into the URL');
});
