import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

test('VoltAgent index lists every VOLTAGENT_ flag read in flags.ts', () => {
  const flags = [...read('server/integrations/voltagent/flags.ts').matchAll(/readFlag\('(VOLTAGENT_[A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(flags.length >= 9, `expected at least 9 flags, found ${flags.length}`);
  const doc = read('docs/voltagent/README.md');
  for (const f of flags) assert.ok(doc.includes(`\`${f}\``), `missing from docs/voltagent/README.md: ${f}`);
});

test('VoltOps keys are documented and guarded', () => {
  const doc = read('docs/voltagent/README.md');
  const guard = read('server/integrations/voltagent/guard.ts');
  for (const k of ['VOLTAGENT_PUBLIC_KEY', 'VOLTAGENT_SECRET_KEY']) {
    assert.ok(guard.includes(`'${k}'`), `guard does not check ${k}`);
    assert.ok(doc.includes(`\`${k}\``), `doc does not name ${k}`);
  }
});

test('relative links in the VoltAgent index and attribution doc resolve', () => {
  for (const file of ['docs/voltagent/README.md', 'docs/mastra-attribution.md']) {
    const text = read(file);
    for (const m of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^https?:/.test(m[1])) continue;
      const target = resolve(dirname(resolve(root, file)), m[1]);
      assert.ok(existsSync(target), `${file} links to missing ${m[1]}`);
    }
    for (const m of text.matchAll(/`((?:server|tests|source|migrations|scripts|docs)\/[^`\s]+)`/g)) {
      assert.ok(existsSync(resolve(root, m[1])), `${file} names missing path ${m[1]}`);
    }
  }
});

test('attribution doc states no Mastra code is copied and names the licence gate', () => {
  const doc = read('docs/mastra-attribution.md');
  assert.match(doc, /No Mastra source code is copied/);
  assert.match(doc, /check:licence/);
  assert.match(doc, /MASTRA_LICENSE_KEY/);
});

