// Issue #394: the transitive @opentelemetry/api pin must satisfy every range
// that a locked package declares on it. npm moved it 1.10.0 -> 1.9.1 in PR #374.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const API = '@opentelemetry/api';

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  assert.ok(m, `not a plain version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmp(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
// Supports the range forms this lockfile uses: "^X.Y.Z" and ">=A <B" (space = AND).
function satisfies(version, range) {
  return range.trim().split(/\s+/).reduce((ok, tok) => {
    if (!ok) return false;
    if (tok.startsWith('^')) {
      const base = tok.slice(1);
      const [maj] = parse(base);
      return maj === parse(version)[0] && cmp(version, base) >= 0;
    }
    if (tok.startsWith('>=')) return cmp(version, tok.slice(2)) >= 0;
    if (tok.startsWith('<')) return cmp(version, tok.slice(1)) < 0;
    throw new Error(`unsupported range token: ${tok}`);
  }, true);
}

function declaredRanges() {
  const out = [];
  for (const [pkgPath, pkg] of Object.entries(lock.packages)) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const range = pkg[field]?.[API];
      if (range) out.push({ from: pkgPath, field, range });
    }
  }
  return out;
}

const locked = lock.packages[`node_modules/${API}`]?.version;

test('lockfile pins @opentelemetry/api at 1.9.1 (decision recorded in #394)', () => {
  assert.equal(locked, '1.9.1');
});

test('locked @opentelemetry/api satisfies every declared range', () => {
  const ranges = declaredRanges();
  assert.ok(ranges.length > 0, 'expected packages that declare a range on the API');
  const failing = ranges.filter((r) => !satisfies(locked, r.range));
  assert.deepEqual(failing, [], `ranges not satisfied by ${locked}`);
});

test('the @voltagent/core range accepts the pin (VoltAgent peer check)', () => {
  const core = lock.packages['node_modules/@voltagent/core'];
  assert.equal(core.dependencies[API], '^1.9.0');
  assert.ok(satisfies('1.9.1', core.dependencies[API]));
});

test('negative: 1.10.0 would break the sdk-* packages capped below 1.10.0', () => {
  const capped = declaredRanges().filter((r) => /<1\.10\.0/.test(r.range));
  assert.ok(capped.length > 0);
  for (const r of capped) assert.equal(satisfies('1.10.0', r.range), false, r.from);
});

test('negative: an out-of-range version is rejected by the comparator', () => {
  assert.equal(satisfies('2.0.0', '^1.9.0'), false);
  assert.equal(satisfies('1.8.9', '^1.9.0'), false);
  assert.equal(satisfies('1.9.1', '>=1.0.0 <1.10.0'), true);
});
