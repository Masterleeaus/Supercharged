/**
 * Form tokens for the public review link. The customer receives the raw token; the database holds only its hash.
 * Lookup is by hash within the company, and the hash comparison is constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { REVIEW_TOKEN_BYTES } from "./types.ts";

export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newReviewToken(random: (size: number) => Uint8Array = (size) => randomBytes(size)): {
  token: string;
  tokenHash: string;
} {
  const token = Buffer.from(random(REVIEW_TOKEN_BYTES)).toString("base64url");
  return { token, tokenHash: hashReviewToken(token) };
}

export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
