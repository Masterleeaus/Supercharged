/** PKCE (RFC 7636) and opaque random values for the OIDC login round trip. */
import { createHash, randomBytes } from 'node:crypto';

export type RandomBytes = (size: number) => Buffer;

const defaultRandom: RandomBytes = (size) => randomBytes(size);

/** 32 random bytes encode to 43 unreserved characters, inside the 43 to 128 range. */
export function randomToken(random: RandomBytes = defaultRandom): string {
  return random(32).toString('base64url');
}

export function createPkce(random: RandomBytes = defaultRandom): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} {
  const codeVerifier = randomToken(random);
  const codeChallenge = Buffer.from(createHash('sha256').update(codeVerifier).digest('hex'), 'hex').toString('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** Constant-time string equality. Lengths are compared first, which reveals only the length. */
export function sameSecretText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
