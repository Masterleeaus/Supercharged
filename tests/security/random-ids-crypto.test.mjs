// Generated IDs in the call and widget paths must come from a CSPRNG, not Math.random (issue #472, task 3).
// Dependency-free static check. Run: node --test tests/security/random-ids-crypto.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const ID_FILES = [
  'server/engines/plivo-elevenlabs/services/outbound-call.service.ts',
  'server/engines/twilio-openai/services/audio-bridge.service.ts',
  'server/modules/widget/public-widget-routes.ts',
  'server/modules/widget/widget-routes.ts',
];

for (const rel of ID_FILES) {
  test(`${rel} does not use Math.random`, () => {
    assert.doesNotMatch(read(rel), /Math\.random\s*\(/);
  });

  test(`${rel} imports randomBytes or randomUUID from crypto`, () => {
    assert.match(read(rel), /import\s*\{[^}]*\b(randomBytes|randomUUID)\b[^}]*\}\s*from\s*['"](node:)?crypto['"]/);
  });
}
