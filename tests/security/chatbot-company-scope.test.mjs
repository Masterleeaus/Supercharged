// Security regression test: every chatbot route runs behind requireCompanyScope.
// Static text test. Run: node --test --experimental-transform-types tests/security/chatbot-company-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const MODULE_INDEX = 'server/modules/chatbot/index.ts';
const ROUTER = 'server/modules/chatbot/chatbot-routes.ts';
const SCOPE = 'server/modules/chatbot/chatbot-scope.ts';
const ROUTES = 'server/routes.ts';

test('registerChatbotModule mounts the router behind requireCompanyScope', () => {
  const src = read(MODULE_INDEX);
  const mount = src.split(/\r?\n/).find((l) => l.includes('app.use(basePath') && l.includes('createChatbotRouter'));
  assert.ok(mount, 'registerChatbotModule must mount the chatbot router with app.use(basePath, ...)');
  assert.match(mount, /options\.requireCompanyScope/);
  assert.ok(mount.indexOf('authenticate') < mount.indexOf('options.requireCompanyScope'),
    'authentication must run before the company-scope guard');
  assert.match(src, /requireCompanyScope:\s*RequestHandler;/, 'requireCompanyScope must be required, not optional');
});

test('server/routes.ts registers the chatbot module with requireCompanyScope', () => {
  assert.match(read(ROUTES), /registerChatbotModule\(app,\s*\{\s*requireCompanyScope:\s*requireCompanyScope\(\)/);
});

test('every CHATBOT_ROUTES entry has a matching router handler', () => {
  const src = read(ROUTER);
  const declared = [...src.matchAll(/\{\s*method:\s*"(GET|POST|PATCH)",\s*path:\s*"([^"]+)"\s*\}/g)];
  const handlers = [...src.matchAll(/router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)];
  assert.ok(declared.length > 0, 'CHATBOT_ROUTES must list routes');
  assert.equal(handlers.length, declared.length, 'route list and router handlers must have the same count');
  for (const [, method, path] of declared) {
    assert.ok(handlers.some(([, m, p]) => m.toUpperCase() === method && p === path),
      `${method} ${path} must be a router handler`);
  }
});

test('chatbot-scope.ts validates the company id with isCompanyId', () => {
  const src = read(SCOPE);
  assert.match(src, /import\s*\{\s*isCompanyId\s*\}\s*from/);
  assert.match(src, /if\s*\(\s*!isCompanyId\(companyId\)\s*\)/);
  assert.match(src, /new ChatbotError\("Company scope required", 403\)/);
});
