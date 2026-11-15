/**
 * Issue #54: one canonical product-name constant (shared/brand.ts) feeds server fallbacks.
 * Customer identity and the Diploy/Envato notice are not derived from it and stay untouched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('shared/brand.ts exports the canonical product name', () => {
  assert.match(read('shared/brand.ts'), /export const PRODUCT_NAME = 'Supercharged' as const;/);
});

test('server fallbacks import PRODUCT_NAME instead of repeating the literal', () => {
  for (const file of [
    'server/routes/public-routes.ts',
    'server/routes/admin/branding-routes.ts',
    'server/services/email-service.ts',
    'server/services/notification-service.ts',
    'server/services/elevenlabs.ts',
  ]) {
    const source = read(file);
    assert.match(source, /import \{ PRODUCT_NAME \} from '[./]*shared\/brand\.ts';/, `${file} must import PRODUCT_NAME`);
    assert.doesNotMatch(source, /'Supercharged'/, `${file} must not repeat the product literal`);
  }
});

test('the ElevenLabs post-call webhook is named for Supercharged', () => {
  assert.match(read('server/services/elevenlabs.ts'), /name: `\$\{PRODUCT_NAME\} Post-Call Webhook`,/);
  assert.doesNotMatch(read('server/services/elevenlabs.ts'), /AgentLabs Post-Call Webhook/);
});

test('the diploy-core product constant no longer reports the former product name', () => {
  const constants = read('packages/diploy-core/constants.ts');
  assert.match(constants, /product: 'Supercharged'/);
  assert.doesNotMatch(constants, /product: 'AgentLabs'/);
  // Vendor name and copyright stay: they are the legally required attribution.
  assert.match(constants, /name: 'Diploy'/);
  assert.match(constants, /copyright: '© 2025 Diploy'/);
});
