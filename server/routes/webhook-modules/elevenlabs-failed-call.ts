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
import { calls, agents, sipPhoneNumbers } from '../../../shared/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { recordWebhookReceived } from '../../engines/payment/webhook-helper';
import { isTypeMismatchError } from './webhook-shared';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';

export async function handleFailedCallTracking(res: Response, ctx: ElevenLabsWebhookCtx): Promise<any> {
  const { data, agent_id, conversation_id, status, webhookTranscript, metadata, analysis, callDirection, extractedFromNumber, extractedToNumber, extractedCallSid } = ctx;
    // CASE 3: Failed call tracking - create record for calls that failed immediately (payment errors, etc.)
    // This ensures even failed calls are visible in call history
    if (!ctx.callRecord && agent_id && metadata?.error) {
      const errorInfo = metadata.error;
      const terminationReason = metadata.termination_reason || 'Unknown error';
      logger.error(`📞 [ElevenLabs Webhook] Creating failed call record for error: ${terminationReason}`);

      try {
        // Look up agent fresh for this scope
        const [failedCallAgent] = await db
          .select()
          .from(agents)
          .where(eq(agents.elevenLabsAgentId, agent_id))
          .limit(1);

        if (!failedCallAgent) {
          logger.warn(`⚠️ [ElevenLabs Webhook] Cannot create failed call record - agent not found: ${agent_id}`);
        } else {
          const callDirection = metadata?.phone_call?.direction || 'inbound';
          const callerPhoneNumber = extractedFromNumber || 'Unknown';
          const calledNumber = extractedToNumber || 'Unknown';
          const callDuration = metadata?.call_duration_secs || 0;

          // Try to get sync data even for failed calls
          const { callSyncService } = await import('../../services/call-sync');
          const syncedData = await callSyncService.syncFromWebhook({
            conversationId: conversation_id,
            agentId: agent_id,
            transcript: webhookTranscript,
            analysis,
            metadata,
            status: 'failed',
            callDurationSecs: callDuration,
          });

          // Check if this is a SIP agent - create SIP call record
          if (failedCallAgent.telephonyProvider === 'elevenlabs-sip') {
            // Look for SIP phone number
            const [sipPhoneNumber] = await db
              .select()
              .from(sipPhoneNumbers)
              .where(eq(sipPhoneNumbers.agentId, failedCallAgent.id))
              .limit(1);

            if (sipPhoneNumber) {
              const endedAt = new Date();
              const startedAt = new Date(endedAt.getTime() - (callDuration * 1000));

              // FIX: Correct From/To for failed SIP calls
              let failedFrom = callerPhoneNumber;
              let failedTo = calledNumber;
              const failedSipDigits = sipPhoneNumber.phoneNumber.replace(/[^0-9]/g, '');
              const failedFromDigits = failedFrom ? failedFrom.replace(/[^0-9]/g, '') : '';
              const failedToDigits = failedTo ? failedTo.replace(/[^0-9]/g, '') : '';
              const failedFromIsSip = failedFromDigits && (failedSipDigits.endsWith(failedFromDigits) || failedFromDigits.endsWith(failedSipDigits));
              const failedToIsSip = failedToDigits && (failedSipDigits.endsWith(failedToDigits) || failedToDigits.endsWith(failedSipDigits));

              if (callDirection === 'inbound' && failedFromIsSip && !failedToIsSip) {
                const temp = failedFrom;
                failedFrom = failedTo;
                failedTo = temp || sipPhoneNumber.phoneNumber;
              } else if (callDirection === 'outbound' && failedToIsSip && !failedFromIsSip) {
                const temp = failedTo;
                failedTo = failedFrom;
                failedFrom = temp || sipPhoneNumber.phoneNumber;
              }

              await db.execute(sql`
              INSERT INTO sip_calls (
                user_id, agent_id, sip_trunk_id, sip_phone_number_id,
                engine, elevenlabs_conversation_id, from_number, to_number,
                direction, status, duration_seconds, transcript, metadata,
                ai_summary, started_at, ended_at
              )
              VALUES (
                ${failedCallAgent.userId}, ${failedCallAgent.id}, ${sipPhoneNumber.sipTrunkId}, ${sipPhoneNumber.id},
                'elevenlabs-sip', ${conversation_id}, ${failedFrom}, ${failedTo},
                ${callDirection}, 'failed', ${callDuration},
                ${syncedData.rawTranscript ? JSON.stringify(syncedData.rawTranscript) : null}::jsonb,
                ${JSON.stringify({
                error: errorInfo,
                terminationReason,
                agentName: failedCallAgent.name,
                failedCall: true,
              })}::jsonb,
                ${syncedData.aiSummary || terminationReason},
                ${startedAt}, ${endedAt}
              )
            `);
              logger.error(`✅ [ElevenLabs Webhook] Created failed SIP call record for: ${conversation_id}`);
              await recordWebhookReceived('elevenlabs');
              return res.sendStatus(200);
            }
          }

          // For non-SIP agents, create regular call record.
          // Provider webhooks carry no session, so company comes from the owning agent record.
          // Fail closed: refuse rather than insert a row without company_id.
          const companyId: string | null = failedCallAgent.companyId ?? null;
          if (!companyId) {
            logger.warn(`[ElevenLabs Webhook] Refusing failed call insert: agent ${failedCallAgent.id} has no company_id`);
            return res.sendStatus(403);
          }
          const failedCallValues = {
            userId: failedCallAgent.userId,
            companyId,
            campaignId: null,
            contactId: null,
            phoneNumber: calledNumber !== 'Unknown' ? calledNumber : callerPhoneNumber,
            fromNumber: callerPhoneNumber,
            toNumber: calledNumber,
            status: 'failed',
            callDirection: callDirection === 'outbound' ? 'outgoing' : 'incoming',
            elevenLabsConversationId: conversation_id,
            twilioSid: extractedCallSid || null,
            duration: callDuration,
            transcript: syncedData.transcript,
            aiSummary: syncedData.aiSummary || terminationReason,
            classification: 'failed',
            endedAt: new Date(),
            metadata: {
              error: errorInfo,
              terminationReason,
              agentName: failedCallAgent.name,
              failedCall: true,
              createdFromWebhook: true,
            },
          };
          let failedCallRecord;
          try {
            [failedCallRecord] = await db
              .insert(calls)
              .values(failedCallValues)
              .returning();
          } catch (failedInsertErr: any) {
            if (isTypeMismatchError(failedInsertErr)) {
              logger.warn(`[ElevenLabs Webhook] Type mismatch on failed call INSERT, retrying with raw SQL`);
              const metaJson = JSON.stringify(failedCallValues.metadata);
              const rawResult = await db.execute(sql`
              INSERT INTO calls (
                company_id, user_id, campaign_id, contact_id, phone_number, from_number, to_number,
                status, call_direction, elevenlabs_conversation_id, twilio_sid,
                duration, transcript, ai_summary, classification, ended_at, metadata
              ) VALUES (
                ${companyId}::uuid, ${failedCallValues.userId}::text, NULL, NULL,
                ${failedCallValues.phoneNumber}, ${failedCallValues.fromNumber}, ${failedCallValues.toNumber},
                ${failedCallValues.status}, ${failedCallValues.callDirection},
                ${failedCallValues.elevenLabsConversationId}, ${failedCallValues.twilioSid},
                ${failedCallValues.duration}::int, ${failedCallValues.transcript}, ${failedCallValues.aiSummary},
                ${failedCallValues.classification}, ${failedCallValues.endedAt}, ${metaJson}::jsonb
              ) RETURNING *
            `);
              failedCallRecord = rawResult.rows[0] as any;
            } else {
              throw failedInsertErr;
            }
          }

          ctx.callRecord = failedCallRecord;
          logger.error(`✅ [ElevenLabs Webhook] Created failed call record: ${ctx.callRecord.id}`);
        }
      } catch (failedCallError: any) {
        logger.error(`❌ [ElevenLabs Webhook] Error creating failed call record:`, failedCallError.message);
      }
    }
}
