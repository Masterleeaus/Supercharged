// Wiring regression test for lane 9:
//  - every Plivo route, GET or POST, is guarded by verifyPlivo (signature, then replay);
//  - the SMS delivery-receipt route exists, is guarded, and does not acknowledge before it is wired;
//  - the Twilio and ElevenLabs webhook handlers run the shared webhookRateLimiter.
// Static source test: no server, database or network is started.
// Run: node --test --experimental-transform-types tests/security/plivo-get-and-rate-limit-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const PLIVO_ROUTES = 'server/engines/plivo/routes/plivo-webhooks.ts';
const WEBHOOK_ROUTES = 'server/routes/webhook-routes.ts';

// Every app.<method>('/api/plivo/...', ...) registration in the Plivo routes file.
function plivoRegistrations(src) {
  const re = /app\.(get|post|put|patch|delete|all)\(\s*'(\/api\/plivo[^']*)'\s*,([^\n]*)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ method: m[1], path: m[2], rest: m[3] });
  }
  return out;
}

test('every Plivo route registration includes verifyPlivo before its handler', () => {
  const src = read(PLIVO_ROUTES);
  const regs = plivoRegistrations(src);
  assert.ok(regs.length > 0, 'no Plivo registrations found');
  for (const r of regs) {
    assert.match(
      r.rest,
      /^\s*verifyPlivo\s*,/,
      `${r.method.toUpperCase()} ${r.path} is not guarded by verifyPlivo`,
    );
  }
});

test('the GET transfer route and the GET incoming health check are guarded', () => {
  const src = read(PLIVO_ROUTES);
  assert.match(src, /app\.get\('\/api\/plivo\/voice\/transfer',\s*verifyPlivo,/);
  assert.match(src, /app\.get\('\/api\/plivo\/incoming',\s*verifyPlivo,/);
});

test('no unguarded GET remains on the Plivo transfer path', () => {
  const src = read(PLIVO_ROUTES);
  const transferGets = plivoRegistrations(src).filter(
    (r) => r.method === 'get' && r.path === '/api/plivo/voice/transfer',
  );
  assert.equal(transferGets.length, 2, 'expected the two existing GET registrations');
  for (const r of transferGets) {
    assert.match(r.rest, /^\s*verifyPlivo\s*,/);
  }
});

test('the signature base for a GET uses the full original URL, including the query string', () => {
  const sig = read('server/engines/plivo/plivo-signature.ts');
  assert.match(sig, /const url = `\$\{publicBase\}\$\{req\.originalUrl\}`;/);
});

test('the SMS delivery-receipt route is guarded and delegates to the injected handler, 503 only when none is injected', () => {
  const src = read(PLIVO_ROUTES);
  assert.match(src, /app\.post\('\/api\/plivo\/sms\/status',\s*verifyPlivo,/);
  const block = src.slice(src.indexOf("'/api/plivo/sms/status'"), src.indexOf("'/api/plivo/sms/inbound'"));
  // Without injected deps it answers 503 and writes nothing.
  assert.match(block, /status\(503\)/);
  assert.match(block, /await smsStatusHandler\(req, res\)/);
  assert.match(src, /createSmsStatusHandler\(smsDeps\)/);
  assert.match(src, /export function setupPlivoWebhooks\(app: Express, baseUrl: string, smsDeps\?/);
});

test('the inbound SMS route is guarded by verifyPlivo and delegates to the injected handler', () => {
  const src = read(PLIVO_ROUTES);
  assert.match(src, /app\.post\('\/api\/plivo\/sms\/inbound',\s*verifyPlivo,/);
  assert.match(src, /await smsInboundHandler\(req, res\)/);
  assert.match(src, /createSmsInboundHandler\(smsDeps\)/);
});

test('webhook-routes.ts imports the shared webhookRateLimiter and defines the in-handler guard', () => {
  const src = read(WEBHOOK_ROUTES);
  assert.match(src, /import\s*\{\s*webhookRateLimiter\s*\}\s*from\s*'\.\.\/middleware\/rateLimiter'/);
  assert.match(src, /async function enforceWebhookRateLimit\(req: Request, res: Response\): Promise<boolean>/);
  assert.match(src, /status\(429\)/);
});

test('each Twilio and ElevenLabs webhook handler runs the rate limit as its first statement', () => {
  const src = read(WEBHOOK_ROUTES);
  const handlers = [
    'handleIncomingCallWebhook',
    'handleTwilioVoiceWebhook',
    'handleTwilioStatusWebhook',
    'handleTwilioRecordingWebhook',
    'handleFlowVoiceAnswer',
    'handleFlowNode',
    'handleFlowGather',
    'handleFlowContinue',
    'handleFlowStatus',
    'handleElevenLabsWebhook',
  ];
  for (const name of handlers) {
    const sig = `export async function ${name}(req: Request, res: Response) {`;
    const at = src.indexOf(sig);
    assert.ok(at >= 0, `${name} signature not found`);
    const firstLine = src.slice(at + sig.length).split(/\r?\n/)[1];
    assert.equal(
      firstLine.trim(),
      'if (!(await enforceWebhookRateLimit(req, res))) return;',
      `${name} does not run the rate limit first`,
    );
  }
});
