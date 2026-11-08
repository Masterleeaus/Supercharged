import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  normalizeOrigin,
  validateAllowedOrigins,
  originFromHeaders,
  isOriginAllowed,
} from '../../server/modules/agent-embed/origin-policy.ts';
import {
  issueEmbedToken,
  verifyEmbedToken,
  assertEmbedSecret,
  readEmbedSecret,
  EMBED_SECRET_MIN_LENGTH,
} from '../../server/modules/agent-embed/embed-token.ts';
import { validateEmbeddableAgent, validateTheme } from '../../server/modules/agent-embed/agent-embed-types.ts';

// Pure logic only. No network, no database, no Express.

const SECRET = 'test-secret-0123456789abcdefghijklmnop'; // 40 chars
const T0 = 1_800_000_000_000; // fixed clock, ms
const clockAt = (ms) => () => ms;
const ALLOWED = ['https://client.example', 'https://shop.example.com:8443'];

// ---------- origin policy ----------

test('normalizeOrigin accepts explicit https origins and canonicalises them', () => {
  assert.equal(normalizeOrigin('https://Client.Example'), 'https://client.example');
  assert.equal(normalizeOrigin('https://client.example/'), 'https://client.example');
  assert.equal(normalizeOrigin('https://client.example:443'), 'https://client.example');
  assert.equal(normalizeOrigin('  https://shop.example.com:8443  '), 'https://shop.example.com:8443');
});

test('normalizeOrigin refuses wildcards', () => {
  assert.equal(normalizeOrigin('*'), null);
  assert.equal(normalizeOrigin('https://*.client.example'), null);
  assert.equal(normalizeOrigin('https://client.*'), null);
});

test('normalizeOrigin refuses malformed or non-origin input', () => {
  for (const bad of [
    '',
    '   ',
    'null',
    'client.example',
    'ftp://client.example',
    'javascript:alert(1)',
    'https://client.example/path',
    'https://client.example/?q=1',
    'https://client.example/#frag',
    'https://user:pass@client.example',
    'https://client .example',
    'https://',
    'not a url',
    42,
    null,
    undefined,
  ]) {
    assert.equal(normalizeOrigin(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('normalizeOrigin refuses plain http, even for localhost, unless loopback is explicitly allowed', () => {
  assert.equal(normalizeOrigin('http://client.example'), null);
  assert.equal(normalizeOrigin('http://localhost:3000'), null);
  assert.equal(normalizeOrigin('http://localhost:3000', { allowLoopbackHttp: true }), 'http://localhost:3000');
  assert.equal(normalizeOrigin('http://127.0.0.1:8080', { allowLoopbackHttp: true }), 'http://127.0.0.1:8080');
  assert.equal(normalizeOrigin('http://client.example', { allowLoopbackHttp: true }), null);
});

test('validateAllowedOrigins fails closed on an empty list and reports every bad entry', () => {
  assert.equal(validateAllowedOrigins([]).ok, false);
  assert.equal(validateAllowedOrigins(null).ok, false);
  const result = validateAllowedOrigins(['https://ok.example', '*', 'https://a.example/path', 7]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /wildcards/);
});

test('validateAllowedOrigins canonicalises and de-duplicates', () => {
  const result = validateAllowedOrigins(['https://Client.example', 'https://client.example/', 'https://shop.example.com:8443']);
  assert.deepEqual(result, { ok: true, origins: ['https://client.example', 'https://shop.example.com:8443'] });
});

test('validateAllowedOrigins caps the list length', () => {
  const many = Array.from({ length: 51 }, (_, i) => `https://site${i}.example`);
  assert.equal(validateAllowedOrigins(many).ok, false);
});

test('originFromHeaders prefers Origin and refuses an opaque "null" Origin without falling back to Referer', () => {
  assert.equal(originFromHeaders({ origin: 'https://client.example', referer: 'https://other.example/page' }), 'https://client.example');
  assert.equal(originFromHeaders({ origin: 'null', referer: 'https://client.example/page' }), null);
  assert.equal(originFromHeaders({ origin: ['https://client.example', 'https://x.example'] }), 'https://client.example');
});

test('originFromHeaders uses the Referer origin when Origin is absent, and returns null with neither', () => {
  assert.equal(originFromHeaders({ referer: 'https://client.example/a/b?c=d' }), 'https://client.example');
  assert.equal(originFromHeaders({ referer: 'not a url' }), null);
  assert.equal(originFromHeaders({}), null);
});

test('isOriginAllowed matches only exact canonical origins', () => {
  assert.equal(isOriginAllowed('https://client.example', ALLOWED), true);
  assert.equal(isOriginAllowed('https://CLIENT.example/', ALLOWED), true);
  assert.equal(isOriginAllowed('https://shop.example.com:8443', ALLOWED), true);
  assert.equal(isOriginAllowed('https://evil.client.example', ALLOWED), false, 'subdomain of allowed origin');
  assert.equal(isOriginAllowed('https://client.example.evil.test', ALLOWED), false, 'suffix trick');
  assert.equal(isOriginAllowed('http://client.example', ALLOWED), false, 'scheme mismatch');
  assert.equal(isOriginAllowed('https://shop.example.com', ALLOWED), false, 'port mismatch');
});

test('isOriginAllowed fails closed for empty or missing lists, null candidates and wildcard entries', () => {
  assert.equal(isOriginAllowed('https://client.example', []), false);
  assert.equal(isOriginAllowed('https://client.example', undefined), false);
  assert.equal(isOriginAllowed(undefined, ALLOWED), false);
  assert.equal(isOriginAllowed('null', ALLOWED), false);
  assert.equal(isOriginAllowed('https://anything.example', ['https://*.example']), false, 'wildcard entry must never match');
  assert.equal(isOriginAllowed('https://anything.example', ['*']), false);
});

// ---------- embed tokens ----------

test('assertEmbedSecret refuses missing and short secrets without echoing them', () => {
  assert.throws(() => assertEmbedSecret(undefined), /missing or shorter than 32/);
  assert.throws(() => assertEmbedSecret(null), /missing or shorter/);
  assert.throws(() => assertEmbedSecret(''), /missing or shorter/);
  const short = 'SHORT-SECRET-DO-NOT-LOG-1234567'; // 31 chars
  assert.equal(short.length, EMBED_SECRET_MIN_LENGTH - 1);
  assert.throws(
    () => assertEmbedSecret(short),
    (err) => err instanceof Error && !err.message.includes(short),
  );
  assert.equal(assertEmbedSecret(SECRET), SECRET);
});

test('issueEmbedToken and verifyEmbedToken round-trip the bound claims', () => {
  const { token, claims, expiresAt } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://Client.example/', capabilities: ['chat', 'booking', 'chat'] },
    SECRET,
    { now: clockAt(T0), ttlSeconds: 300 },
  );
  assert.equal(claims.origin, 'https://client.example');
  assert.deepEqual(claims.capabilities, ['chat', 'booking']);
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(expiresAt, new Date(T0 + 300_000).toISOString());
  assert.equal(token.split('.').length, 2);
  assert.ok(!token.includes(SECRET), 'secret must not appear in the token');

  const result = verifyEmbedToken(
    token,
    SECRET,
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capability: 'booking' },
    { now: clockAt(T0 + 10_000) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims.agentId, 'agent_1');
  assert.equal(result.claims.companyId, 'co_9');
});

test('each issued token gets a distinct jti', () => {
  const input = { agentId: 'a', companyId: 'c', origin: 'https://client.example', capabilities: ['chat'] };
  const a = issueEmbedToken(input, SECRET, { now: clockAt(T0) });
  const b = issueEmbedToken(input, SECRET, { now: clockAt(T0) });
  assert.notEqual(a.claims.jti, b.claims.jti);
});

test('tampering with the claims segment is detected', () => {
  const { token } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    SECRET,
    { now: clockAt(T0) },
  );
  const [payload, sig] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.companyId = 'co_OTHER';
  const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
  const result = verifyEmbedToken(forged, SECRET, { agentId: 'agent_1', companyId: 'co_OTHER', origin: 'https://client.example' }, { now: clockAt(T0) });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});

test('tampering with the signature, or signing with another secret, is detected', () => {
  const expectation = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example' };
  const { token } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    SECRET,
    { now: clockAt(T0) },
  );
  const [payload, sig] = token.split('.');
  const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyEmbedToken(`${payload}.${flipped}`, SECRET, expectation, { now: clockAt(T0) }).reason, 'bad_signature');

  const otherSecret = 'another-secret-abcdefghijklmnopqrstu';
  const { token: foreign } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    otherSecret,
    { now: clockAt(T0) },
  );
  assert.equal(verifyEmbedToken(foreign, SECRET, expectation, { now: clockAt(T0) }).reason, 'bad_signature');
});

test('tokens expire: valid up to exp, rejected at exp', () => {
  const { token, claims } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    SECRET,
    { now: clockAt(T0), ttlSeconds: 60 },
  );
  const expectation = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example' };
  assert.equal(verifyEmbedToken(token, SECRET, expectation, { now: clockAt(T0 + 59_000) }).ok, true);
  assert.deepEqual(
    verifyEmbedToken(token, SECRET, expectation, { now: clockAt(claims.exp * 1000) }),
    { ok: false, reason: 'expired' },
  );
  assert.equal(verifyEmbedToken(token, SECRET, expectation, { now: clockAt(T0 + 3_600_000) }).reason, 'expired');
});

test('tokens issued well in the future are refused', () => {
  const { token } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    SECRET,
    { now: clockAt(T0 + 3_600_000) },
  );
  const result = verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example' }, { now: clockAt(T0) });
  assert.equal(result.reason, 'not_yet_valid');
});

test('a token minted for one origin is refused for another (wrong origin)', () => {
  const { token } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    SECRET,
    { now: clockAt(T0) },
  );
  const now = { now: clockAt(T0 + 1000) };
  assert.equal(verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_9', origin: 'https://evil.example' }, now).reason, 'wrong_origin');
  assert.equal(verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_9', origin: 'https://*.client.example' }, now).reason, 'wrong_origin');
  assert.equal(verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_9', origin: 'http://client.example' }, now).reason, 'wrong_origin');
  assert.equal(verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_9', origin: 'not an origin' }, now).reason, 'wrong_origin');
});

test('a token is refused for another agent or company, and for a capability it lacks', () => {
  const { token } = issueEmbedToken(
    { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] },
    SECRET,
    { now: clockAt(T0) },
  );
  const now = { now: clockAt(T0) };
  assert.equal(verifyEmbedToken(token, SECRET, { agentId: 'agent_2', companyId: 'co_9', origin: 'https://client.example' }, now).reason, 'wrong_agent');
  assert.equal(verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_1', origin: 'https://client.example' }, now).reason, 'wrong_company');
  assert.equal(
    verifyEmbedToken(token, SECRET, { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capability: 'knowledge' }, now).reason,
    'missing_capability',
  );
});

test('missing or short secrets throw on both issue and verify, and nothing is produced', () => {
  const input = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] };
  const expectation = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example' };
  for (const bad of [undefined, null, '', 'too-short']) {
    assert.throws(() => issueEmbedToken(input, bad), /agent-embed: token secret/);
    assert.throws(() => verifyEmbedToken('a.b', bad, expectation), /agent-embed: token secret/);
  }
});

test('readEmbedSecret reads from configuration and returns undefined when unset', () => {
  assert.equal(readEmbedSecret({}), undefined);
  assert.equal(readEmbedSecret({ AGENT_EMBED_TOKEN_SECRET: '' }), undefined);
  assert.equal(readEmbedSecret({ AGENT_EMBED_TOKEN_SECRET: SECRET }), SECRET);
});

test('issueEmbedToken refuses wildcard and malformed origins, bad ids and bad TTLs', () => {
  const base = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'] };
  assert.throws(() => issueEmbedToken({ ...base, origin: 'https://*.client.example' }, SECRET), /origin/);
  assert.throws(() => issueEmbedToken({ ...base, origin: '*' }, SECRET), /origin/);
  assert.throws(() => issueEmbedToken({ ...base, companyId: '' }, SECRET), /companyId/);
  assert.throws(() => issueEmbedToken({ ...base, agentId: 'a b' }, SECRET), /agentId/);
  assert.throws(() => issueEmbedToken({ ...base, capabilities: ['admin'] }, SECRET), /capabilities/);
  assert.throws(() => issueEmbedToken({ ...base, capabilities: [] }, SECRET), /capabilities/);
  assert.throws(() => issueEmbedToken(base, SECRET, { ttlSeconds: 0 }), /ttlSeconds/);
  assert.throws(() => issueEmbedToken(base, SECRET, { ttlSeconds: 901 }), /ttlSeconds/);
  assert.throws(() => issueEmbedToken(base, SECRET, { ttlSeconds: 1.5 }), /ttlSeconds/);
});

test('verifyEmbedToken rejects malformed tokens without throwing', () => {
  const expectation = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example' };
  for (const bad of [undefined, 42, '', 'nodot', 'a.b.c', '.sig', 'payload.', 'x'.repeat(5000)]) {
    assert.equal(verifyEmbedToken(bad, SECRET, expectation).reason, 'malformed', `case ${String(bad).slice(0, 20)}`);
  }
});

test('verifyEmbedToken rejects a correctly signed token whose claims are malformed or over-long', () => {
  const expectation = { agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example' };
  const sign = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${payload}.${createHmac('sha256', SECRET).update(payload, 'utf8').digest('base64url')}`;
  };
  const good = { v: 1, agentId: 'agent_1', companyId: 'co_9', origin: 'https://client.example', capabilities: ['chat'], iat: 1_800_000_000, exp: 1_800_000_100, jti: 'j' };
  assert.equal(verifyEmbedToken(sign({ ...good, v: 2 }), SECRET, expectation, { now: clockAt(T0) }).reason, 'bad_claims');
  assert.equal(verifyEmbedToken(sign({ ...good, iat: 'x' }), SECRET, expectation, { now: clockAt(T0) }).reason, 'bad_claims');
  assert.equal(
    verifyEmbedToken(sign({ ...good, exp: good.iat + 3600 }), SECRET, expectation, { now: clockAt(good.iat * 1000) }).reason,
    'ttl_too_long',
  );
  assert.equal(verifyEmbedToken(sign(good), SECRET, expectation, { now: clockAt(good.iat * 1000) }).ok, true);
});

// ---------- agent config model ----------

const VALID_AGENT = {
  agentId: 'agent_1',
  companyId: 'co_9',
  displayName: 'Sam, the booking assistant',
  enabled: true,
  allowedOrigins: ALLOWED,
  capabilities: ['chat', 'booking', 'chat'],
  theme: { primaryColor: '#112233', position: 'bottom-left' },
};

test('validateEmbeddableAgent accepts a complete agent and de-duplicates capabilities', () => {
  const result = validateEmbeddableAgent(VALID_AGENT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.capabilities, ['chat', 'booking']);
  assert.equal(result.value.companyId, 'co_9');
});

test('validateEmbeddableAgent refuses an agent without companyId', () => {
  const { companyId, ...noCompany } = VALID_AGENT;
  const result = validateEmbeddableAgent(noCompany);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /companyId is required/);
});

test('validateEmbeddableAgent refuses unknown capabilities, bad colours and an empty capability list', () => {
  assert.equal(validateEmbeddableAgent({ ...VALID_AGENT, capabilities: ['voice-admin'] }).ok, false);
  assert.equal(validateEmbeddableAgent({ ...VALID_AGENT, capabilities: [] }).ok, false);
  assert.equal(validateEmbeddableAgent({ ...VALID_AGENT, theme: { primaryColor: 'red', position: 'bottom-left' } }).ok, false);
  assert.equal(validateTheme({ primaryColor: '#abcdef', position: 'top' }).ok, false);
  assert.equal(validateEmbeddableAgent(null).ok, false);
});

// ---------- embed script (static checks) ----------

const scriptSource = readFileSync(new URL('../../server/modules/agent-embed/embed-script.js', import.meta.url), 'utf8');

test('embed-script.js compiles as a classic script', () => {
  assert.doesNotThrow(() => new vm.Script(scriptSource, { filename: 'embed-script.js' }));
});

test('embed-script.js holds no provider credential and names no model provider', () => {
  assert.doesNotMatch(scriptSource, /openai|anthropic|elevenlabs|gemini|mistral|api\.(openai|anthropic)/i);
  assert.doesNotMatch(scriptSource, /sk-[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(scriptSource, /api[_-]?key/i);
});

test('embed-script.js makes only platform /embed/ requests, through one fetch call', () => {
  const fetchCalls = scriptSource.match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, 'all requests go through the single request() helper');
  assert.match(scriptSource, /agentPath \+ '\/config'/);
  assert.match(scriptSource, /agentPath \+ '\/session'/);
  assert.match(scriptSource, /'\/embed\/' \+ encodeURIComponent\(agentId\)|encodeURIComponent\(agentId\)/);
});

test('embed-script.js renders server data as text, never as HTML', () => {
  assert.doesNotMatch(scriptSource, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(scriptSource, /textContent/);
});

test('embed-script.js only accepts messages from the platform origin and its own iframe', () => {
  assert.match(scriptSource, /event\.origin !== base/);
  assert.match(scriptSource, /event\.source !== state\.iframe\.contentWindow/);
  assert.match(scriptSource, /postMessage\(\s*\{[^}]*\},\s*base\s*\)/);
});
