import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Binds the forgot-password reset to the verify step that issued it.
// verify-otp issues a random token and stores only its SHA-256 hash on the verified row.
// reset must present the token; an email plus a verified OTP row is not enough.
export const RESET_WINDOW_MS = 10 * 60 * 1000;

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashResetToken(token) };
}

export function canResetWithToken(params: {
  presentedToken: unknown;
  storedHash: string | null;
  verifiedAt: Date;
  now: Date;
}): boolean {
  const { presentedToken, storedHash, verifiedAt, now } = params;
  if (!storedHash || typeof presentedToken !== "string" || presentedToken.length === 0) return false;
  if (now.getTime() - verifiedAt.getTime() > RESET_WINDOW_MS) return false;
  const given = Buffer.from(hashResetToken(presentedToken));
  const stored = Buffer.from(storedHash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}
