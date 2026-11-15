'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { db } from '../../db';
import { elevenLabsCredentials } from '../../../shared/schema';
import { eq, or } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { verifyElevenLabsWebhookAgainstSecrets } from '../../services/elevenlabs-webhook-signature';
import { storage } from '../../storage';

/**
 * Get all webhook secrets from the credential pool for multi-secret verification
 * Returns unique secrets from all active credentials plus the global fallback
 */
export async function getAllWebhookSecrets(): Promise<string[]> {
  const secrets: Set<string> = new Set();

  try {
    // Get all credential secrets from the pool
    const credentials = await db
      .select({ webhookSecret: elevenLabsCredentials.webhookSecret })
      .from(elevenLabsCredentials)
      .where(eq(elevenLabsCredentials.isActive, true));

    for (const cred of credentials) {
      if (cred.webhookSecret) {
        secrets.add(cred.webhookSecret);
      }
    }

    // Add global fallback secret
    const dbSecretSetting = await storage.getGlobalSetting('elevenlabs_hmac_secret');
    const globalSecret = (dbSecretSetting?.value as string) || process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (globalSecret) {
      secrets.add(globalSecret);
    }
  } catch (err: any) {
    logger.warn(`   ⚠️ Error fetching credential secrets: ${err.message}`);
    // Try global fallback
    const dbSecretSetting = await storage.getGlobalSetting('elevenlabs_hmac_secret');
    const globalSecret = (dbSecretSetting?.value as string) || process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (globalSecret) {
      secrets.add(globalSecret);
    }
  }

  return Array.from(secrets);
}

/**
 * Verify webhook signature by trying all available secrets
 * This is secure because we verify BEFORE trusting any body data
 * Returns the matching secret if found, null otherwise
 */
export async function verifyWithAllSecrets(
  rawBody: string,
  signatureHeader: string | undefined
): Promise<{ verified: boolean; matchedSecret?: string; error?: string }> {
  // Fail closed: no configured secret or a missing/invalid signature rejects the webhook.
  const allSecrets = await getAllWebhookSecrets();
  return verifyElevenLabsWebhookAgainstSecrets(rawBody, signatureHeader, allSecrets);
}
