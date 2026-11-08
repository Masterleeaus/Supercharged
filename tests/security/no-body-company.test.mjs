// Security regression test: tenant id must come from the verified caller, never from request input.
// Static text test. Run: node --test --experimental-transform-types tests/security/no-body-company.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const FILES = [
  'server/routes/flow-automation-routes.ts',
  'server/routes/template-routes.ts',
  'server/routes/incoming-connections-routes.ts',
  'server/routes/crm-routes.ts',
  'server/modules/chatbot/chatbot-routes.ts',
];
const DIRS = ['server/modules/booking-agent'];

function filesUnder(dir) {
  return fs.readdirSync(new URL(dir + '/', ROOT))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join(dir, f));
}

const ALL = [...FILES, ...DIRS.flatMap(filesUnder)];

// Dotted, optional-chained and bracket reads of companyId from request input.
const BODY_COMPANY = [
  /\breq\??\.(body|query|params)\??\.companyId\b/,
  /\breq\??\.(body|query|params)\??\[\s*['"`]companyId['"`]\s*\]/,
  // Destructuring such as: const { companyId } = req.body
  /\{[^}]*\bcompanyId\b[^}]*\}\s*=\s*req\??\.(body|query|params)\b/,
];

test('the target file set is non-empty and includes the booking-agent module', () => {
  assert.ok(ALL.length >= FILES.length + 1, 'booking-agent directory must contribute .ts files');
  assert.ok(ALL.some((f) => f.startsWith('server/modules/booking-agent/')));
});

for (const file of ALL) {
  test(`${file} does not read companyId from request input`, () => {
    const src = read(file);
    for (const pattern of BODY_COMPANY) {
      assert.doesNotMatch(src, pattern, `${file} must take companyId from res.locals, not the request`);
    }
  });
}
