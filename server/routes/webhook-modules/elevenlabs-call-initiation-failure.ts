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
import { Response } from 'express';
import { db } from '../../db';
import { calls, campaigns } from '../../../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { storage } from '../../storage';
import { webhookDeliveryService } from '../../services/webhook-delivery';
import { recordWebhookReceived } from '../../engines/payment/webhook-helper';
import { resyncSinglePhoneCredentials } from '../../services/elevenlabs-phone-resync';
import { markCampaignForRetry } from '../../engines/elevenlabs-migration';
import { pendingCallFailures } from './webhook-shared';

export async function handleCallInitiationFailureWebhook(res: Response, data: any): Promise<any> {
      logger.error(`📞 [ElevenLabs Webhook] Call initiation failed`);
      const { agent_id, conversation_id, failure_reason, metadata: failureMetadata } = data || {};
      logger.info(`   Agent ID: ${agent_id}`);
      logger.info(`   Conversation ID: ${conversation_id}`);
      logger.error(`   Failure reason: ${failure_reason}`);

      // Try to update the call record if it exists — check both calls and sip_calls tables
      if (conversation_id) {
        let callRecord = null;
        let callTable: 'calls' | 'sip_calls' = 'calls';

        // First try the main calls table
        const [mainCallRecord] = await db
          .select()
          .from(calls)
          .where(eq(calls.elevenLabsConversationId, conversation_id))
          .limit(1);

        if (mainCallRecord) {
          callRecord = mainCallRecord;
          callTable = 'calls';
        } else {
          // Try sip_calls table
          const sipCallResult = await db.execute(sql`
            SELECT * FROM sip_calls WHERE elevenlabs_conversation_id = ${conversation_id} OR external_call_id = ${conversation_id} LIMIT 1
          `);
          if (sipCallResult.rows.length > 0) {
            callRecord = sipCallResult.rows[0] as any;
            callTable = 'sip_calls';
          }
        }

        if (callRecord) {
          if (callTable === 'sip_calls') {
            await db.execute(sql`
              UPDATE sip_calls SET 
                status = 'failed',
                ended_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
              failureReason: failure_reason,
              failureMetadata: failureMetadata,
            })}::jsonb
              WHERE id = ${callRecord.id}
            `);
            logger.error(`   Updated SIP call ${callRecord.id} as failed`);
          } else {
            await db
              .update(calls)
              .set({
                status: 'failed',
                endedAt: new Date(),
                metadata: {
                  ...callRecord.metadata as object,
                  failureReason: failure_reason,
                  failureMetadata: failureMetadata,
                }
              })
              .where(eq(calls.id, callRecord.id));
            logger.error(`   Updated call ${callRecord.id} as failed`);

            // Trigger call.failed webhook if user is known
            if (callRecord.userId) {
              const contact = callRecord.contactId ? await storage.getContact(callRecord.contactId) : null;
              const campaign = callRecord.campaignId ? await storage.getCampaign(callRecord.campaignId) : null;

              webhookDeliveryService.triggerEvent((callRecord as any).companyId ?? (callRecord as any).company_id ?? null, callRecord.userId, 'call.failed', {
                campaign: campaign ? { id: campaign.id, name: campaign.name, type: campaign.type } : null,
                contact: contact ? {
                  id: contact.id,
                  firstName: contact.firstName,
                  lastName: contact.lastName,
                  phone: contact.phone,
                  email: contact.email,
                  customFields: contact.customFields,
                } : { phone: callRecord.phoneNumber },
                call: {
                  id: callRecord.id,
                  status: 'failed',
                  phoneNumber: callRecord.phoneNumber,
                  failureReason: failure_reason,
                  startedAt: callRecord.startedAt,
                  endedAt: new Date(),
                }
              }, callRecord.campaignId).catch(err => {
                logger.error('❌ [Webhook] Error triggering call.failed event:', err);
              });
            }

            // AUTO-RESYNC: If failure reason indicates stale Twilio credentials in ElevenLabs,
            // re-register the phone number with current credentials in the background.
            const isAuthRetryFailure = typeof failure_reason === 'string' &&
              (/max.*auth/i.test(failure_reason) ||
                /auth.*retry/i.test(failure_reason));

            if (isAuthRetryFailure) {
              logger.error(`🔄 [ElevenLabs Webhook] Auth retry failure detected — triggering background credential resync`);
              logger.error(`   Failure reason: "${failure_reason}"`);

              const campaignId = callRecord.campaignId;
              let phoneDbId: string | null = null;

              if (campaignId) {
                const [campaign] = await db
                  .select({ phoneNumberId: campaigns.phoneNumberId })
                  .from(campaigns)
                  .where(eq(campaigns.id, campaignId))
                  .limit(1);
                if (campaign?.phoneNumberId) {
                  phoneDbId = campaign.phoneNumberId;
                }
              }

              if (!phoneDbId) {
                logger.warn(`⚠️ [ElevenLabs Webhook] Could not resolve phone number for resync — no campaignId on call record; skipping retry queue`);
              }

              if (phoneDbId) {
                (async () => {
                  try {
                    logger.info(`🔄 [ElevenLabs Webhook] Resyncing phone DB id: ${phoneDbId}`);
                    const resyncResult = await resyncSinglePhoneCredentials(phoneDbId!);
                    if (resyncResult.success) {
                      logger.info(`✅ [ElevenLabs Webhook] Credential resync succeeded for phone ${phoneDbId}`);
                      if (campaignId) {
                        logger.info(`🔄 [ElevenLabs Webhook] Marking campaign ${campaignId} for retry after successful resync`);
                        await markCampaignForRetry(campaignId, `Auto-retry after credential resync (original failure: ${failure_reason})`);
                      }
                    } else {
                      logger.error(`❌ [ElevenLabs Webhook] Credential resync failed: ${resyncResult.error}`);
                      logger.warn(`⚠️ [ElevenLabs Webhook] Campaign retry NOT scheduled — credentials may still be stale`);
                    }
                  } catch (resyncErr: any) {
                    logger.error(`❌ [ElevenLabs Webhook] Background resync error: ${resyncErr?.message ?? resyncErr}`);
                  }
                })();
              }
            }
          }
        } else {
          // No call record found yet — store as pending failure for race condition handling
          if (conversation_id && failure_reason) {
            pendingCallFailures.set(conversation_id, {
              failure_reason,
              metadata: failureMetadata,
              timestamp: Date.now(),
            });
            logger.error(`   ⏳ Stored pending failure for conversation ${conversation_id} (will be applied if SIP record is created later)`);
          }
        }
      }
      await recordWebhookReceived('elevenlabs');
      return res.sendStatus(200);
}
