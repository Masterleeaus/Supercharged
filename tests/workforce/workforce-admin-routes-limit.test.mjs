/**
 * Checks for the rate limiter and the workforce admin router.
 *   1. server/middleware/rateLimiter.ts loads under the test loader (its imports carry extensions).
 *   2. server/workforce/runtime/workforce-admin-routes.ts applies apiRateLimiter in the route chain,
 *      before the first route is registered.
 * Run: node --test --experimental-transform-types tests/workforce/workforce-admin-routes-limit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRateLimiter } from '../../server/middleware/rateLimiter.ts';

const ROUTER_FILE = fileURLToPath(new URL('../../server/workforce/runtime/workforce-admin-routes.ts', import.meta.url));

test('rate limiter loads and exports apiRateLimiter as a middleware function', () => {
  assert.equal(typeof apiRateLimiter, 'function');
  assert.equal(apiRateLimiter.length, 3);
});

test('workforce admin router applies apiRateLimiter before its first route', () => {
  const source = readFileSync(ROUTER_FILE, 'utf8');
  const chainAt = source.indexOf('const chain: RequestHandler[] = [');
  const firstRouteAt = source.search(/router\.(get|post|put|patch|delete|use)\(/);
  assert.ok(chainAt > 0, 'route chain definition not found');
  assert.ok(firstRouteAt > chainAt, 'first route must be registered after the chain is defined');
  const chainLine = source.slice(chainAt, source.indexOf('\n', chainAt));
  assert.match(chainLine, /requireCompanyScope[\s\S]*apiRateLimiter/, 'apiRateLimiter must follow company scope in the chain');
  assert.ok(chainLine.includes('apiRateLimiter'), 'apiRateLimiter must be in the chain');
  assert.match(source, /import \{ apiRateLimiter \} from '\.\.\/\.\.\/middleware\/rateLimiter\.ts';/);
});
