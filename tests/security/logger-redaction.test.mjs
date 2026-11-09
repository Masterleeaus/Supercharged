// Security regression test: server/utils/logger.ts must redact secrets, OTP-style keys,
// emails and card numbers before anything is written.
// Run: node --test --experimental-transform-types tests/security/logger-redaction.test.mjs
//
// All values below are fake. Console output is captured, never written to stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Silence console output before importing server code (test runner IPC uses stdout).
const captured = [];
const sink = (...args) => {
  captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
console.log = sink;
console.info = sink;
console.warn = sink;
console.error = sink;
console.debug = sink;

process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'debug';

const { logger, redactForLog } = await import('../../server/utils/logger.ts');

const FAKE_BEARER = 'FAKEBEARERTOKEN123456';
const FAKE_KEY = 'sk_test_FAKEKEY00000000';
const FAKE_JWT = 'eyJFAKEHEADER.eyJFAKEPAYLOAD.FAKESIGNATURE';
const FAKE_EMAIL = 'jason@example.com';
const FAKE_CARD = '4242424242424242';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const lastOutput = () => captured[captured.length - 1] ?? '';

test('message text: bearer token, key, JWT, email and card are removed', () => {
  captured.length = 0;
  logger.info(`auth Bearer ${FAKE_BEARER} key ${FAKE_KEY} jwt ${FAKE_JWT} mail ${FAKE_EMAIL} card ${FAKE_CARD}`);
  const out = lastOutput();
  assert.ok(!out.includes(FAKE_BEARER), 'bearer token must not be logged');
  assert.ok(!out.includes(FAKE_KEY), 'sk_ key must not be logged');
  assert.ok(!out.includes(FAKE_JWT), 'JWT must not be logged');
  assert.ok(!out.includes(FAKE_EMAIL), 'full email must not be logged');
  assert.ok(!out.includes(FAKE_CARD), 'full card number must not be logged');
  assert.ok(out.includes('Bearer [redacted]'));
});

test('source text is redacted too', () => {
  captured.length = 0;
  logger.info('ok', undefined, `src ${FAKE_EMAIL}`);
  assert.ok(!lastOutput().includes(FAKE_EMAIL));
});

test('sensitive keys in data are replaced whatever the value type', () => {
  captured.length = 0;
  logger.error('failed', {
    password: 'FAKEPASS',
    otp: 123456,
    api_key: 'FAKEAPIKEYVALUE',
    nested: { authorization: 'Basic FAKE', cookie: 'FAKECOOKIE', list: [{ session: 'FAKESESSION' }] },
    harmless: 'visible',
  });
  const out = lastOutput();
  for (const leaked of ['FAKEPASS', '123456', 'FAKEAPIKEYVALUE', 'FAKE', 'FAKECOOKIE', 'FAKESESSION']) {
    assert.ok(!out.includes(leaked), `${leaked} must not be logged`);
  }
  assert.ok(out.includes('"harmless": "visible"'), 'non-sensitive data must stay readable');
});

test('email in data keeps only first local character and domain', () => {
  captured.length = 0;
  logger.info('mail', { to: FAKE_EMAIL });
  assert.ok(lastOutput().includes('j****@example.com'));
});

test('card number in data keeps only last four digits', () => {
  captured.length = 0;
  logger.info('card', { note: FAKE_CARD });
  const out = lastOutput();
  assert.ok(out.includes('************4242'));
  assert.ok(!out.includes(FAKE_CARD));
});

test('redactForLog returns a copy and does not mutate its input', () => {
  const input = { token: 'FAKETOKEN', list: [FAKE_EMAIL], nested: { card: FAKE_CARD } };
  const snapshot = JSON.stringify(input);
  const out = redactForLog(input);
  assert.equal(JSON.stringify(input), snapshot, 'input must be unchanged');
  assert.equal(out.token, '[redacted]');
  assert.notEqual(out, input);
});

test('cyclic references and over-deep values become [truncated]', () => {
  const cyc = { name: 'x' };
  cyc.self = cyc;
  assert.equal(redactForLog(cyc).self, '[truncated]');

  let deep = { leaf: 'v' };
  for (let i = 0; i < 12; i++) deep = { child: deep };
  let node = redactForLog(deep);
  let found = false;
  while (node && typeof node === 'object') {
    if (node.child === '[truncated]') { found = true; break; }
    node = node.child;
  }
  assert.ok(found, 'values deeper than the limit must be truncated');
});

test('Date values still log as ISO strings', () => {
  captured.length = 0;
  const when = new Date('2026-11-04T00:00:00.000Z');
  logger.info('when', { at: when });
  assert.ok(lastOutput().includes('2026-11-04T00:00:00.000Z'));
});

test('http() response preview is redacted', () => {
  captured.length = 0;
  logger.http('POST', '/api/test', 200, 5, { token: 'FAKERESPONSETOKEN', email: FAKE_EMAIL });
  const out = lastOutput();
  assert.ok(!out.includes('FAKERESPONSETOKEN'));
  assert.ok(!out.includes(FAKE_EMAIL));
});

test('logger does not import the workforce module', () => {
  const src = read('server/utils/logger.ts');
  assert.doesNotMatch(src, /from\s+['"][^'"]*workforce/, 'logger must copy the rules, not import them');
});

test('an Error passed as data keeps its message, and secrets in it are redacted', () => {
  captured.length = 0;
  logger.error('call failed', new Error(`upstream rejected Bearer ${FAKE_BEARER} for ${FAKE_EMAIL}`));
  const out = lastOutput();
  assert.ok(out.includes('upstream rejected'), 'error message must be logged, not {}');
  assert.ok(!out.includes(FAKE_BEARER), 'bearer token inside an error message must not be logged');
  assert.ok(!out.includes(FAKE_EMAIL), 'email inside an error message must not be logged');
});
