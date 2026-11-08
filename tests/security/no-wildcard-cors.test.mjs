// Security regression test: public and widget endpoints must not send Access-Control-Allow-Origin: '*'.
// Static text test. Run: node --test --experimental-transform-types tests/security/no-wildcard-cors.test.mjs
//
// Documented exceptions (not CORS, so excluded from the check):
//   - server/index.ts `app.use("*", ...)`: an Express catch-all route pattern, not a CORS header.
//   - server/routes/public-routes.ts `userAgent: '*'`: a request body value, not a CORS header.
// No CORS exception is granted for these files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const FILES = [
  'server/routes/public-routes.ts',
  'server/index.ts',
  'server/modules/widget/public-widget-routes.ts',
];

// Header set via header()/setHeader()/set(), or a cors({ origin }) option, with a literal '*'.
const WILDCARD_PATTERNS = [
  /Access-Control-Allow-Origin['"`]\s*,\s*['"`]\*['"`]/i,
  /Access-Control-Allow-Origin\s*[:=]\s*['"`]\*['"`]/i,
  /\borigin\s*:\s*['"`]\*['"`]/,
];

for (const file of FILES) {
  test(`${file} does not send a wildcard CORS origin`, () => {
    const src = read(file);
    for (const pattern of WILDCARD_PATTERNS) {
      assert.doesNotMatch(src, pattern, `${file} must not use a literal '*' CORS origin`);
    }
  });
}

test('widget CORS keeps its allowlist (the check is meaningful)', () => {
  const src = read('server/modules/widget/public-widget-routes.ts');
  assert.match(src, /res\.header\('Access-Control-Allow-Origin', origin\)/,
    'widget must echo only an allowlisted origin');
  assert.match(src, /WIDGET_ALLOWED_ORIGINS/);
});
