// Shared fakes for the Central OIDC tests. No network, no real Central values.
export const ORIGIN = 'https://central.example.test';
export const ISSUER = 'https://central.example.test/oidc';
export const AUTHORIZE = `${ISSUER}/auth`;
export const TOKEN = `${ISSUER}/token`;
export const INTERNAL = 'https://central-internal.example.test';
export const CLIENT_ID = 'desk-client-test';
export const CLIENT_SECRET = 'd'.repeat(40);
export const AUDIENCE = 'urn:test:desk-audience';
export const PRODUCT_AUDIENCE = 'urn:titan-central:product:supercharged';
export const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
export const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

export const signInConfig = Object.freeze({
  centralOrigin: ORIGIN,
  audience: AUDIENCE,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

export const discoveryDoc = Object.freeze({
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE,
  token_endpoint: TOKEN,
  jwks_uri: `${ISSUER}/jwks`,
  code_challenge_methods_supported: ['S256'],
});

/** Routes fake HTTP by URL. Each handler returns a Response-like value or throws. */
export function routedFetch(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[url] ?? routes[new URL(url).pathname];
    if (!handler) throw new Error(`unrouted fake fetch: ${new URL(url).pathname}`);
    const out = typeof handler === 'function' ? await handler(init, url) : handler;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetcher, calls };
}

export function standardRoutes(overrides = {}) {
  return { '/.well-known/openid-configuration': discoveryDoc, ...overrides };
}
