// Security regression test: the RAG tool webhook compares its bearer token in constant time.
// Static text test. Run: node --test --experimental-transform-types tests/security/rag-tool-webhook-token.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../server/routes/rag-knowledge-routes.ts', import.meta.url), 'utf8');
const start = src.indexOf('router.post("/tool-webhook"');
const body = src.slice(start, src.indexOf('const { query, agent_id', start));

test('tool webhook imports timingSafeEqual from crypto', () => {
  assert.match(src, /import \{ timingSafeEqual \} from "crypto";/);
});

test('tool webhook compares the bearer token with timingSafeEqual after a length check', () => {
  assert.match(body, /Buffer\.from\(authHeader\?\.replace\('Bearer ', ''\) \?\? '', 'utf8'\)/);
  assert.match(body, /providedBuf\.length !== expectedBuf\.length \|\| !timingSafeEqual\(providedBuf, expectedBuf\)/);
  assert.doesNotMatch(body, /providedToken !== webhookToken/, 'the plain !== compare must be gone');
});

test('tool webhook still fails closed when WEBHOOK_TOKEN is unset, and still answers 401 on mismatch', () => {
  assert.match(body, /WEBHOOK_TOKEN not configured - endpoint disabled/);
  assert.match(body, /res\.status\(503\)/);
  assert.match(body, /res\.status\(401\)\.json\(\{ error: "Invalid webhook token" \}\)/);
});
