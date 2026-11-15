/** ID token verification for Central sign-in. Fails closed with a reason code and never echoes token contents. */
import {createPublicKey, verify as cryptoVerify} from 'node:crypto';
import type {Jwk} from './discovery.ts';
import {safeEqual} from './pkce.ts';

type AlgSpec = {kty: 'RSA' | 'EC'; crv?: 'P-256' | 'P-384'; hash: 'sha256' | 'sha384'};
// No 'none', no HMAC: a shared secret is never valid for an IdP-signed token.
const ALGS: Record<string, AlgSpec> = {
 RS256: {kty: 'RSA', hash: 'sha256'},
 ES256: {kty: 'EC', crv: 'P-256', hash: 'sha256'},
 ES384: {kty: 'EC', crv: 'P-384', hash: 'sha384'},
};

export type IdTokenFailure =
 | 'malformed' | 'alg_not_allowed' | 'unknown_key' | 'bad_signature' | 'bad_key'
 | 'issuer' | 'audience' | 'expired' | 'not_yet_valid' | 'nonce' | 'subject';

export type IdTokenResult = {ok: true; claims: Record<string, unknown>} | {ok: false; reason: IdTokenFailure};

export type KeyLookup = (kid: string) => Promise<Jwk | null>;

const b64urlJson = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const SUBJECT = /^[^\s\x00-\x1f\x7f]{1,256}$/u;

function decodeParts(token: string): {header: any; payload: any; signingInput: string; signature: Buffer} | null {
 if (typeof token !== 'string' || token.length > 16384) return null;
 const parts = token.split('.');
 if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]*$/.test(p))) return null;
 try {
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return null;
  return {header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url')};
 } catch {
  return null;
 }
}

function verifySignature(alg: string, spec: AlgSpec, jwk: Jwk, signingInput: string, signature: Buffer): boolean | 'bad_key' {
 if (jwk.kty !== spec.kty || (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.alg !== undefined && jwk.alg !== alg))
  return 'bad_key';
 if (spec.crv && jwk.crv !== spec.crv) return 'bad_key';
 let key;
 try {
  key = createPublicKey({key: jwk as any, format: 'jwk'});
 } catch {
  return 'bad_key';
 }
 const data = Buffer.from(signingInput, 'utf8');
 try {
  if (spec.kty === 'RSA') return cryptoVerify(spec.hash, data, key, signature);
  // JWS ECDSA signatures are raw r||s, not DER.
  return cryptoVerify(spec.hash, data, {key, dsaEncoding: 'ieee-p1363'}, signature);
 } catch {
  return false;
 }
}

export async function verifyIdToken(token: string, opts: {
 issuer: string;
 audience: string;
 clientId: string;
 nonce: string;
 getKey: KeyLookup;
 now?: number;
 skewSeconds?: number;
}): Promise<IdTokenResult> {
 const now = Math.floor((opts.now ?? Date.now()) / 1000);
 const skew = opts.skewSeconds ?? 60;
 const parts = decodeParts(token);
 if (!parts) return {ok: false, reason: 'malformed'};
 const {header, payload, signingInput, signature} = parts;

 const alg = typeof header.alg === 'string' ? header.alg : '';
 const spec = Object.prototype.hasOwnProperty.call(ALGS, alg) ? ALGS[alg] : undefined;
 if (!spec) return {ok: false, reason: 'alg_not_allowed'};

 if (typeof header.kid !== 'string' || header.kid.length > 256) return {ok: false, reason: 'unknown_key'};
 const jwk = await opts.getKey(header.kid);
 if (!jwk) return {ok: false, reason: 'unknown_key'};
 const sig = verifySignature(alg, spec, jwk, signingInput, signature);
 if (sig === 'bad_key') return {ok: false, reason: 'bad_key'};
 if (sig !== true) return {ok: false, reason: 'bad_signature'};

 if (payload.iss !== opts.issuer) return {ok: false, reason: 'issuer'};

 const aud: unknown[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
 if (!aud.includes(opts.audience)) return {ok: false, reason: 'audience'};
 // OIDC Core 3.1.3.7: with several audiences, azp must be this client.
 if (aud.length > 1 && payload.azp !== opts.clientId) return {ok: false, reason: 'audience'};

 if (typeof payload.exp !== 'number' || now > payload.exp + skew) return {ok: false, reason: 'expired'};
 if (typeof payload.iat === 'number' && payload.iat > now + skew) return {ok: false, reason: 'not_yet_valid'};
 if (typeof payload.nbf === 'number' && payload.nbf > now + skew) return {ok: false, reason: 'not_yet_valid'};

 if (!safeEqual(payload.nonce, opts.nonce)) return {ok: false, reason: 'nonce'};
 if (typeof payload.sub !== 'string' || !SUBJECT.test(payload.sub)) return {ok: false, reason: 'subject'};

 return {ok: true, claims: payload as Record<string, unknown>};
}
