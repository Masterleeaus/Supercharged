/**
 * Confirmation tokens for marketplace writes and bulk batches. The seller confirms a reviewed action with a
 * short-lived HMAC-signed token. Port of Support/MarketplaceWriteApprovalToken.php, with the signing secret
 * injected. Construction fails closed: a missing or short secret throws.
 *
 * Token format: base64url(payload JSON) "." base64url(HMAC-SHA256(payload part)).
 * Only sha256(token) is stored on the proposal or batch, so a database read cannot replay a token.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MarketplaceError } from "./errors.ts";

export const MIN_APPROVAL_SECRET_LENGTH = 32;

export interface ApprovalPayload {
  kind: "write" | "bulk";
  subjectId: string;
  actionHash: string;
  companyId: string;
  userId: string;
  jti: string;
  expiresAtMs: number;
}

export interface ApprovalSigner {
  issue(payload: Omit<ApprovalPayload, "jti" | "expiresAtMs">, ttlMs: number, nowMs: number): string;
  verify(token: string, nowMs: number): ApprovalPayload;
}

export function createApprovalSigner(secret: string): ApprovalSigner {
  if (typeof secret !== "string" || secret.length < MIN_APPROVAL_SECRET_LENGTH) {
    throw new MarketplaceError("misconfigured", "Marketplace write approval signing secret is missing or too short.");
  }
  const key = Buffer.from(secret, "utf8");

  const sign = (encodedPayload: string): string =>
    createHmac("sha256", key).update(encodedPayload, "utf8").digest("base64url");

  return {
    issue(payload, ttlMs, nowMs) {
      const full: ApprovalPayload = { ...payload, jti: randomUUID(), expiresAtMs: nowMs + ttlMs };
      const encoded = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
      return `${encoded}.${sign(encoded)}`;
    },
    verify(token, nowMs) {
      const parts = token.split(".");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        throw new MarketplaceError("confirmation_invalid", "The confirmation token is invalid.");
      }
      const expected = Buffer.from(sign(parts[0]), "utf8");
      const given = Buffer.from(parts[1], "utf8");
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        throw new MarketplaceError("confirmation_invalid", "The confirmation token is invalid.");
      }
      let payload: ApprovalPayload;
      try {
        payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as ApprovalPayload;
      } catch {
        throw new MarketplaceError("confirmation_invalid", "The confirmation token is invalid.");
      }
      if (typeof payload.expiresAtMs !== "number" || payload.expiresAtMs <= nowMs) {
        throw new MarketplaceError("confirmation_expired", "The confirmation has expired. Prepare the action again.");
      }
      return payload;
    },
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. Different lengths compare unequal. */
export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
