/**
 * Auth tokens accepted for Plivo-ElevenLabs SIP trunk webhooks.
 *
 * The shared verifier (server/engines/plivo/plivo-signature.ts) reads only plivo_credentials.
 * ElevenLabs trunk calls are placed with sip_trunks.username / sip_trunks.password
 * (server/infrastructure/bullmq/call-worker.ts), so Plivo signs their callbacks with the
 * trunk token. This loader accepts both. The trunk password is read as stored, the same way
 * the outbound call path reads it.
 */
import { sipTrunks } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { loadActiveAuthTokens } from '../plivo/plivo-signature';

export async function loadPlivoElevenLabsAuthTokens(): Promise<string[]> {
  const [accountTokens, trunkRows] = await Promise.all([
    loadActiveAuthTokens(),
    db
      .select({ password: sipTrunks.password })
      .from(sipTrunks)
      .where(and(eq(sipTrunks.provider, 'plivo'), eq(sipTrunks.isActive, true))),
  ]);
  const trunkTokens = trunkRows
    .map((r) => r.password)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  return [...new Set([...accountTokens, ...trunkTokens])];
}
