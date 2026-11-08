'use strict';
/**
 * ElevenLabs webhook signature verification (fail closed).
 *
 * Header format: ElevenLabs-Signature: t=<unix seconds>,v0=<hex HMAC-SHA256>
 * Signed payload: `${t}.${rawBody}`, keyed with the shared webhook secret.
 *
 * A webhook is accepted only when it carries a valid, fresh signature that matches
 * one of the configured secrets. No secret configured, a missing header, a stale
 * timestamp or a mismatch all reject the request.
 */
import crypto from 'crypto';

export const ELEVENLABS_SIGNATURE_TOLERANCE_SECONDS = 30 * 60;

export interface ElevenLabsSignatureCheck {
  valid: boolean;
  error?: string;
}

export interface ElevenLabsWebhookVerification {
  verified: boolean;
  matchedSecret?: string;
  error?: string;
}

export function verifyElevenLabsSignature(
  body: string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ElevenLabsSignatureCheck {
  if (!signatureHeader) {
    return { valid: false, error: 'Missing ElevenLabs-Signature header' };
  }

  try {
    let timestamp: string | undefined;
    let receivedSignature: string | undefined;
    for (const part of signatureHeader.split(',')) {
      if (part.startsWith('t=')) timestamp = part.substring(2);
      else if (part.startsWith('v0=')) receivedSignature = part;
    }

    if (!timestamp || !receivedSignature) {
      return { valid: false, error: 'Invalid signature format' };
    }

    const requestTime = parseInt(timestamp, 10);
    if (!Number.isFinite(requestTime) || requestTime < nowSeconds - ELEVENLABS_SIGNATURE_TOLERANCE_SECONDS) {
      return { valid: false, error: 'Request expired - timestamp too old' };
    }

    const expectedHash = 'v0=' + crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    if (expectedHash.length !== receivedSignature.length) {
      return { valid: false, error: 'Signature mismatch' };
    }

    const isValid = crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(receivedSignature));
    return { valid: isValid, error: isValid ? undefined : 'Signature mismatch' };
  } catch {
    return { valid: false, error: 'Signature verification failed' };
  }
}

/**
 * Accepts the webhook only if it verifies against at least one configured secret.
 * An empty secret list rejects everything: there is nothing to verify against.
 */
export function verifyElevenLabsWebhookAgainstSecrets(
  rawBody: string,
  signatureHeader: string | undefined,
  secrets: readonly string[],
  nowSeconds?: number
): ElevenLabsWebhookVerification {
  const usable = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  if (usable.length === 0) {
    return { verified: false, error: 'No ElevenLabs webhook secret configured; webhook rejected' };
  }
  if (!signatureHeader) {
    return { verified: false, error: 'Missing ElevenLabs-Signature header' };
  }
  for (const secret of usable) {
    if (verifyElevenLabsSignature(rawBody, signatureHeader, secret, nowSeconds).valid) {
      return { verified: true, matchedSecret: secret };
    }
  }
  return { verified: false, error: 'Signature did not match any configured secrets' };
}
