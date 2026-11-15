/** PKCE (RFC 7636, S256) and opaque random tokens for state and nonce. */
import {createHash, randomBytes} from 'node:crypto';

export type RandomBytes = (n: number) => Buffer;

export function randomToken(random: RandomBytes = randomBytes): string {
 return random(32).toString('base64url');
}

export function createPkce(random: RandomBytes = randomBytes): {
 codeVerifier: string;
 codeChallenge: string;
 codeChallengeMethod: 'S256';
} {
 const codeVerifier = random(32).toString('base64url'); // 43 chars, within RFC 7636 limits
 const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
 return {codeVerifier, codeChallenge, codeChallengeMethod: 'S256'};
}

/** Constant-time string comparison for state, nonce and cookie values. */
export function safeEqual(a: unknown, b: unknown): boolean {
 if (typeof a !== 'string' || typeof b !== 'string') return false;
 const ab = Buffer.from(a, 'utf8');
 const bb = Buffer.from(b, 'utf8');
 if (ab.length !== bb.length) return false;
 let diff = 0;
 for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
 return diff === 0;
}
