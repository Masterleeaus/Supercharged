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
import { calls } from '../../../shared/schema';
import { eq, or, sql } from 'drizzle-orm';
import { twilioService } from '../../services/twilio';
import { logger } from '../../utils/logger';
import { recordWebhookReceived } from '../../engines/payment/webhook-helper';
import { isTypeMismatchError } from './webhook-shared';

export async function handlePostCallAudioWebhook(res: Response, data: any): Promise<any> {
      logger.info(`📞 [ElevenLabs Webhook] Received post_call_audio`);
      const { conversation_id: audioConvId, recording_url, audio_url, metadata: audioMetadata } = data || {};

      logger.info(`   Conversation ID: ${audioConvId || 'N/A'}`);
      logger.info(`   ElevenLabs recording present: ${recording_url || audio_url ? 'yes (not storing - expires)' : 'no'}`);

      // Extract call_sid from metadata for Twilio fallback
      const callSid = audioMetadata?.phone_call?.call_sid || audioMetadata?.call_sid;
      logger.info(`   Call SID for Twilio: ${callSid || 'N/A'}`);

      if (audioConvId) {
        try {
          const [existingCall] = await db
            .select()
            .from(calls)
            .where(eq(calls.elevenLabsConversationId, audioConvId))
            .limit(1);

          if (existingCall) {
            const twilioSid = callSid || existingCall.twilioSid;

            let twilioRecordingUrl: string | null = null;
            if (twilioSid && !existingCall.recordingUrl) {
              logger.info(`   📞 Fetching stable Twilio recording for SID: ${twilioSid}`);
              try {
                const twilioData = await twilioService.getCallDetails(twilioSid);
                if (twilioData?.recordingUrl) {
                  twilioRecordingUrl = twilioData.recordingUrl;
                  logger.info(`   ✅ Got stable Twilio recording URL`);
                } else {
                  logger.info(`   ⚠️ No Twilio recording available (call may not have recording enabled)`);
                }
              } catch (twilioError: any) {
                logger.warn(`   ⚠️ Twilio recording fetch failed: ${twilioError.message}`);
              }
            }

            const audioUpdateData = {
              recordingUrl: twilioRecordingUrl || existingCall.recordingUrl,
              twilioSid: twilioSid,
              metadata: {
                ...existingCall.metadata as object,
                hasElevenLabsRecording: !!(recording_url || audio_url),
                recordingMetadataUpdatedAt: new Date().toISOString(),
              }
            };
            try {
              await db
                .update(calls)
                .set(audioUpdateData)
                .where(eq(calls.id, existingCall.id));
            } catch (audioUpdateErr: any) {
              if (isTypeMismatchError(audioUpdateErr)) {
                logger.warn(`[ElevenLabs Webhook] Type mismatch on audio UPDATE, retrying with raw SQL`);
                const metaJson = JSON.stringify(audioUpdateData.metadata);
                await db.execute(sql`
                  UPDATE calls SET
                    recording_url = ${audioUpdateData.recordingUrl},
                    twilio_sid = ${audioUpdateData.twilioSid},
                    metadata = ${metaJson}::jsonb
                  WHERE id::text = ${existingCall.id}::text
                `);
              } else {
                throw audioUpdateErr;
              }
            }
            logger.info(`   ✅ Updated call record: ${existingCall.id} (Twilio SID: ${twilioSid || 'N/A'})`);
          } else {
            // Check SIP calls table if not found in main calls table
            // Critical for SIP-based clients who don't use Twilio
            const sipCallResult = await db.execute(sql`
              SELECT * FROM sip_calls WHERE elevenlabs_conversation_id = ${audioConvId} OR external_call_id = ${audioConvId} LIMIT 1
            `);
            const existingSipCall = sipCallResult.rows[0] as any;

            if (existingSipCall) {
              logger.info(`   📞 Found SIP call record: ${existingSipCall.id}`);
              await db.execute(sql`
                UPDATE sip_calls SET
                  metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
                hasElevenLabsRecording: !!(recording_url || audio_url),
                recordingMetadataUpdatedAt: new Date().toISOString(),
              })}::jsonb,
                  updated_at = NOW()
                WHERE id = ${existingSipCall.id}
              `);
              logger.info(`   ✅ Updated SIP call record: ${existingSipCall.id}`);
            } else {
              logger.info(`   ⚠️ No call record found (calls or sip_calls) for conversation: ${audioConvId}`);
            }
          }
        } catch (audioError: any) {
          logger.error(`   ❌ Error updating call record:`, audioError.message);
        }
      }

      await recordWebhookReceived('elevenlabs');
      return res.sendStatus(200);
}
