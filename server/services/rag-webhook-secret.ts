/**
 * RAG webhook secret loader. Kept in its own module (no service imports) so it can be unit tested.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

const PERSISTED_SECRET_PATH = path.join(process.cwd(), '.rag-webhook-secret');

// RAG webhook secret. Resolution order (fail closed):
//   1. RAG_WEBHOOK_SECRET environment variable (the supported production source)
//   2. Secret file at PERSISTED_SECRET_PATH, read only (dev fallback; never written by the server)
//   3. DEV-ONLY constant, only when NODE_ENV is explicitly 'development' or 'test'
// No secret is derived from the server signing key, and no secret is generated or written to disk.
export const DEV_ONLY_RAG_WEBHOOK_SECRET = 'DEV-ONLY-INSECURE-rag-webhook-secret';

export function resolveRAGWebhookSecret(
  env: NodeJS.ProcessEnv = process.env,
  secretPath: string = PERSISTED_SECRET_PATH,
): string {
  if (env.RAG_WEBHOOK_SECRET) {
    return env.RAG_WEBHOOK_SECRET;
  }

  try {
    if (fs.existsSync(secretPath)) {
      const fromFile = fs.readFileSync(secretPath, 'utf-8').trim();
      if (fromFile) {
        return fromFile;
      }
    }
  } catch {
    // Unreadable file: fall through to fail closed below.
  }

  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    logger.warn(`📚 [RAG Tool] Using DEV-ONLY RAG webhook secret (NODE_ENV=${env.NODE_ENV})`);
    return DEV_ONLY_RAG_WEBHOOK_SECRET;
  }

  throw new Error('RAG webhook secret is not configured (set RAG_WEBHOOK_SECRET or provide the secret file)');
}

let ragWebhookSecret: string | null = null;

export function getRAGWebhookSecret(): string {
  if (!ragWebhookSecret) {
    ragWebhookSecret = resolveRAGWebhookSecret();
  }
  return ragWebhookSecret;
}

/** Returns the secret, or null when it is not configured. Used where a missing secret must disable, not crash. */
export function tryGetRAGWebhookSecret(): string | null {
  try {
    return getRAGWebhookSecret();
  } catch (err) {
    logger.error('RAG webhook secret is not configured; RAG webhook tools are disabled', { code: (err as Error)?.message }, 'RagTool');
    return null;
  }
}

export function validateRAGWebhookToken(providedToken: string | undefined): boolean {
  if (!providedToken) {
    return false;
  }
  const secret = tryGetRAGWebhookSecret();
  if (!secret) {
    return false;
  }

  // Ensure both tokens have the same length for timing-safe comparison
  const providedBuffer = Buffer.from(providedToken);
  const secretBuffer = Buffer.from(secret);

  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}
