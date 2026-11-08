// Security regression test: the play-audio ElevenLabs tool is protected by the URL secret.
// Static text test. Run: node --test --experimental-transform-types tests/security/play-audio-secret.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const ROUTES = 'server/routes.ts';
const PLAY_AUDIO = 'server/services/play-audio-elevenlabs-tool.ts';
const ROUTE_DECL = 'app.post("/api/elevenlabs/tools/play-audio/:token/:agentId"';

test('play-audio route carries a :token segment and validates it', () => {
  const src = read(ROUTES);
  const at = src.indexOf(ROUTE_DECL);
  assert.ok(at >= 0, 'play-audio route must be registered with a :token segment');
  // The validator call must sit inside this route's handler, before any audio work.
  const handler = src.slice(at, at + 600);
  assert.match(handler, /validateAppointmentWebhookToken\(req\.params\.token\)/);
  assert.ok(handler.indexOf('validateAppointmentWebhookToken') < handler.indexOf('getDomain()'),
    'token check must run before the handler reads the domain or audio');
  assert.match(handler, /res\.status\(401\)/, 'invalid token must return 401');
});

test('routes.ts imports validateAppointmentWebhookToken from the appointment tool service', () => {
  assert.match(read(ROUTES),
    /import\s*\{\s*validateAppointmentWebhookToken\s*\}\s*from\s*"\.\/services\/appointment-elevenlabs-tool"/);
});

test('play-audio tool builds its URL from getAppointmentWebhookSecret with encodeURIComponent', () => {
  const src = read(PLAY_AUDIO);
  assert.match(src, /import\s*\{\s*getAppointmentWebhookSecret\s*\}\s*from\s*'\.\/appointment-elevenlabs-tool'/);
  assert.match(src, /const secret = getAppointmentWebhookSecret\(\);/);
  assert.match(src,
    /const webhookUrl = `\$\{domain\}\/api\/elevenlabs\/tools\/play-audio\/\$\{encodeURIComponent\(secret\)\}\/\$\{elevenLabsAgentId\}`;/,
    'webhook URL must embed encodeURIComponent(secret) in the :token position');
});
