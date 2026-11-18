// IDs and file names built from Math.random are guessable and can collide (issue #6).
// Dependency-free. Checks the four call sites named in the issue use a cryptographic source.
// Run: node --test tests/security/no-math-random-ids.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const CALL_SITES = [
  'server/engines/plivo-elevenlabs/services/outbound-call.service.ts',
  'server/engines/twilio-openai/services/audio-bridge.service.ts',
  'server/modules/widget/public-widget-routes.ts',
  'server/modules/widget/widget-routes.ts',
];

for (const rel of CALL_SITES) {
  test(`${rel} does not use Math.random`, () => {
    assert.equal(/Math\.random/.test(read(rel)), false);
  });

  test(`${rel} imports a cryptographic random source`, () => {
    const src = read(rel);
    assert.match(src, /from\s+['"](crypto|node:crypto)['"]/);
    assert.match(src, /\brandomBytes\b|\brandomUUID\b/);
  });
}
