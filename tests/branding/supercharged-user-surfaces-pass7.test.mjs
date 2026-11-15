/**
 * Issue #54, pass 7: user-visible product names in the admin, marketing, widget and script surfaces say
 * Supercharged. Compatibility identifiers (storage keys, window globals, DOM id prefixes), the Diploy/Envato
 * copyright notice (issue #37) and customer-supplied identity are NOT renamed, and these tests pin that.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const USER_SURFACES = [
  'client/src/components/admin/SEOModule.tsx',
  'client/src/components/admin/SMTPSettings.tsx',
  'client/src/pages/Dashboard.tsx',
  'client/src/pages/Blog.tsx',
  'client/src/pages/BlogPost.tsx',
  'public/widget/embed.js',
  'scripts/build-plugins.js',
  'scripts/run-plugin-migrations.sh',
];

test('changed user-visible surfaces carry no AgentLabs product name', () => {
  for (const file of USER_SURFACES) {
    assert.doesNotMatch(read(file), /AgentLabs|AGENTLABS/, `${file} must say Supercharged`);
  }
});

test('admin and SMTP placeholders show the Supercharged product name', () => {
  const seo = read('client/src/components/admin/SEOModule.tsx');
  assert.match(seo, /placeholder="Supercharged Pro"/);
  assert.match(seo, /placeholder="Supercharged"/);
  assert.match(seo, /placeholder="SUPERCHARGED-PRO-001"/);
  assert.match(read('client/src/components/admin/SMTPSettings.tsx'), /placeholder="Supercharged"/);
});

test('widget fallback app name is Supercharged, and customer platform name still wins', () => {
  const embed = read('public/widget/embed.js');
  assert.match(embed, /config\.platformName \|\| brandingData\?\.app_name \|\| 'Supercharged'/);
  assert.match(embed, /\(config && config\.platformName\) \? config\.platformName : \(brandingData\?\.app_name \|\| 'Supercharged'\)/);
});

test('compatibility identifiers keep their names', () => {
  assert.match(read('client/index.html'), /agentlabs-branding:v3/);
  assert.match(read('client/src/components/BrandingProvider.tsx'), /const CACHE_KEY = "agentlabs-branding:v3"/);
  assert.match(read('client/src/components/CookieConsentBanner.tsx'), /agentlabs_cookie_consent/);
  assert.match(read('client/src/contexts/plugin-registry.tsx'), /__AGENTLABS_PLUGIN_REGISTRY__/);
  assert.match(read('client/src/components/AnalyticsScripts.tsx'), /\[id\^="agentlabs-"\]/);
});

test('the Diploy/Envato copyright notice is untouched (issue #37)', () => {
  assert.match(read('server/middleware/correlation-id.ts'), /@copyright Diploy - AgentLabs/);
  assert.match(read('LICENSE'), /.+/);
});
