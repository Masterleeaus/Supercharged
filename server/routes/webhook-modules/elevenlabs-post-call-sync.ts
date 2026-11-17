'use strict';
/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
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
import { calls, campaigns, agents, appointments, flows } from '../../../shared/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { ElevenLabsService } from '../../services/elevenlabs';
import { ElevenLabsPoolService } from '../../services/elevenlabs-pool';
import { logger } from '../../utils/logger';
import { recordWebhookReceived } from '../../engines/payment/webhook-helper';
import { deductCallCreditsForElevenLabs, triggerCallCompletedWebhook } from '../webhooks/helpers';
import { resyncSinglePhoneCredentials } from '../../services/elevenlabs-phone-resync';
import { markCampaignForRetry } from '../../engines/elevenlabs-migration';
import { flowExecutions } from '@shared/schema';
import { isTypeMismatchError } from './webhook-shared';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';

export async function processPostCallTranscription(res: Response, ctx: ElevenLabsWebhookCtx): Promise<any> {
  const callRecord = ctx.callRecord;
  const { data, agent_id, conversation_id, status, webhookTranscript, metadata, analysis, callDirection, extractedFromNumber, extractedToNumber, extractedCallSid } = ctx;
    logger.info(`   Found call record: ${callRecord.id}`);

    // Process the post_call_transcription webhook data using unified sync service
    logger.info(`📞 [ElevenLabs Webhook] Processing post_call_transcription with unified sync`);

    try {
      // Use sync service to get combined data from both ElevenLabs and Twilio
      const { callSyncService } = await import('../../services/call-sync');
      const syncedData = await callSyncService.syncFromWebhook({
        conversationId: conversation_id,
        agentId: agent_id,
        transcript: webhookTranscript,
        analysis,
        metadata,
        status,
        callDurationSecs: metadata?.call_duration_secs,
      });

      // Update call record with synced data from both sources
      const updates: Record<string, any> = {
        status: 'completed',
        endedAt: new Date(),
        metadata: {
          ...callRecord.metadata as object,
          ...syncedData.metadata,
          webhookProcessed: true,
        }
      };

      // ALWAYS prefer fresh webhook data — this is the post_call_transcription webhook (final call result)
      // syncFromWebhook fetches from ElevenLabs API + Twilio, so this is the most complete data available
      // Previous logic skipped updates if call record already had values, causing missing data
      // for outbound batch/campaign calls where records are pre-created with empty fields
      if (syncedData.duration) {
        updates.duration = syncedData.duration;
      }
      if (syncedData.transcript) {
        updates.transcript = syncedData.transcript;
      }
      if (syncedData.aiSummary) {
        updates.aiSummary = syncedData.aiSummary;
      }
      if (syncedData.classification) {
        updates.classification = syncedData.classification;
      }
      if (syncedData.recordingUrl) {
        updates.recordingUrl = syncedData.recordingUrl;
      }
      if (syncedData.phoneNumber && (!callRecord.phoneNumber || callRecord.phoneNumber === 'Unknown')) {
        updates.phoneNumber = syncedData.phoneNumber;
      }
      if (syncedData.calledNumber && (!callRecord.toNumber || callRecord.toNumber === 'Unknown')) {
        updates.toNumber = syncedData.calledNumber;
      }
      // Backfill fromNumber if missing — check multiple sources including the call record's own metadata
      if (!callRecord.fromNumber || callRecord.fromNumber === 'Unknown') {
        const recordMeta = callRecord.metadata as Record<string, any> | null;
        const backfillFrom = extractedFromNumber
          || syncedData.phoneNumber
          || recordMeta?.fromNumber
          || recordMeta?.twilioFrom;
        if (backfillFrom) {
          updates.fromNumber = backfillFrom;
        }
      }
      // Backfill toNumber if missing — also check call record's own metadata
      if (!callRecord.toNumber || callRecord.toNumber === 'Unknown') {
        const recordMeta = callRecord.metadata as Record<string, any> | null;
        const backfillTo = syncedData.calledNumber
          || extractedToNumber
          || recordMeta?.toNumber
          || recordMeta?.twilioTo;
        if (backfillTo) {
          updates.toNumber = backfillTo;
        }
      }
      // Backfill callDirection if missing — derive from webhook metadata direction or call record metadata
      if (!callRecord.callDirection) {
        const webhookDirection = metadata?.phone_call?.direction;
        const recordMeta = callRecord.metadata as Record<string, any> | null;
        const twilioDirection = recordMeta?.twilioDirection;
        if (webhookDirection === 'inbound') {
          updates.callDirection = 'incoming';
        } else if (webhookDirection === 'outbound') {
          updates.callDirection = 'outgoing';
        } else if (twilioDirection === 'inbound') {
          updates.callDirection = 'incoming';
        } else if (twilioDirection === 'outbound-api' || twilioDirection === 'outbound-dial' || twilioDirection === 'outbound') {
          updates.callDirection = 'outgoing';
        }
      }
      // Store Twilio SID if available
      if (metadata?.call_sid || extractedCallSid) {
        updates.twilioSid = metadata?.call_sid || extractedCallSid;
      }

      try {
        await db
          .update(calls)
          .set(updates)
          .where(eq(calls.id, callRecord.id));
      } catch (updateErr: any) {
        if (isTypeMismatchError(updateErr)) {
          logger.warn(`[ElevenLabs Webhook] Type mismatch on call UPDATE, retrying with raw SQL`);
          const metaJson = JSON.stringify(updates.metadata || {});
          await db.execute(sql`
            UPDATE calls SET
              status = ${updates.status || 'completed'},
              ended_at = ${updates.endedAt || new Date()},
              duration = COALESCE(${updates.duration || null}::int, duration),
              transcript = COALESCE(${updates.transcript || null}, transcript),
              ai_summary = COALESCE(${updates.aiSummary || null}, ai_summary),
              classification = COALESCE(${updates.classification || null}, classification),
              recording_url = COALESCE(${updates.recordingUrl || null}, recording_url),
              phone_number = COALESCE(${updates.phoneNumber || null}, phone_number),
              from_number = COALESCE(${updates.fromNumber || null}, from_number),
              to_number = COALESCE(${updates.toNumber || null}, to_number),
              call_direction = COALESCE(${updates.callDirection || null}, call_direction),
              twilio_sid = COALESCE(${updates.twilioSid || null}, twilio_sid),
              metadata = ${metaJson}::jsonb
            WHERE id::text = ${callRecord.id}::text
          `);
        } else {
          throw updateErr;
        }
      }

      logger.info(`✅ [ElevenLabs Webhook] Updated call record with synced data: ${callRecord.id}`);

      // AUTH-RETRY AUTO-RESYNC (post_call path):
      // If the call failed because ElevenLabs had stale Twilio credentials (SID/Token rotated),
      // trigger a background credential resync + campaign retry — mirrors the same logic in
      // the call_initiation_failure handler.
      // "max auth retry attempts reached" can arrive via post_call_transcription when the call
      // gets a conversation ID before the SIP authentication ultimately fails.
      const postCallTerminationReason = metadata?.termination_reason as string | undefined;
      const isPostCallAuthRetryFailure = typeof postCallTerminationReason === 'string' &&
        (/max.*auth/i.test(postCallTerminationReason) || /auth.*retry/i.test(postCallTerminationReason));

      if (isPostCallAuthRetryFailure) {
        logger.error(`🔄 [ElevenLabs Webhook] Auth retry failure detected in post_call_transcription — triggering background credential resync`);
        logger.info(`   Termination reason: "${postCallTerminationReason}"`);

        const postCallCampaignId = callRecord.campaignId;
        let postCallPhoneDbId: string | null = null;

        if (postCallCampaignId) {
          try {
            const [postCallCampaign] = await db
              .select({ phoneNumberId: campaigns.phoneNumberId })
              .from(campaigns)
              .where(eq(campaigns.id, postCallCampaignId))
              .limit(1);
            if (postCallCampaign?.phoneNumberId) {
              postCallPhoneDbId = postCallCampaign.phoneNumberId;
            } else {
              logger.warn(`⚠️ [ElevenLabs Webhook] Campaign ${postCallCampaignId} has no phoneNumberId — skipping post_call resync`);
            }
          } catch (phoneIdErr: any) {
            logger.warn(`⚠️ [ElevenLabs Webhook] Could not look up phone DB id for post_call resync: [redacted]`);
          }
        }

        if (postCallPhoneDbId) {
          (async () => {
            try {
              logger.info(`🔄 [ElevenLabs Webhook] Post_call resync — phone DB id: ${postCallPhoneDbId}`);
              const resyncResult = await resyncSinglePhoneCredentials(postCallPhoneDbId!);
              if (resyncResult.success) {
                logger.info(`✅ [ElevenLabs Webhook] Credential resync succeeded (post_call path)`);
                if (postCallCampaignId) {
                  logger.info(`🔄 [ElevenLabs Webhook] Marking campaign ${postCallCampaignId} for retry after successful resync`);
                  await markCampaignForRetry(postCallCampaignId,
                    `Auto-retry after credential resync (original failure: ${postCallTerminationReason})`);
                }
              } else {
                logger.error(`❌ [ElevenLabs Webhook] Credential resync failed (post_call path): ${resyncResult.error}`);
                logger.warn(`⚠️ [ElevenLabs Webhook] Campaign retry NOT scheduled — credentials may still be stale`);
              }
            } catch (resyncErr: any) {
              logger.error(`❌ [ElevenLabs Webhook] Resync error (post_call path): ${resyncErr.message}`);
            }
          })();
        } else if (!postCallCampaignId) {
          logger.warn(`⚠️ [ElevenLabs Webhook] Could not resolve phone for post_call resync — call record has no campaignId; skipping resync`);
        }
      }

      // Check if any appointments were booked during this call and link them
      // This handles the case where appointment is booked during call but call record
      // doesn't exist yet when the appointment webhook fires
      try {
        const callPhone = syncedData.phoneNumber || callRecord.phoneNumber;
        if (callPhone && agent_id && callRecord.userId) {
          // Helper to normalize phone for comparison (last 10 digits)
          const normalizePhone = (phone: string | null | undefined): string | null => {
            if (!phone) return null;
            const digits = phone.replace(/[^0-9]/g, '');
            if (digits.length < 6) return null;
            return digits.slice(-10);
          };

          const normalizedCallPhone = normalizePhone(callPhone);

          // Get the database agent ID from the ElevenLabs agent ID
          const [agentRecord] = await db
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.elevenLabsAgentId, agent_id))
            .limit(1);

          // Look for appointments created in the last 10 minutes for this user
          // that haven't been linked to a call yet
          const recentAppointments = await db
            .select()
            .from(appointments)
            .where(and(
              eq(appointments.userId, callRecord.userId),
              sql`${appointments.callId} IS NULL`,
              sql`${appointments.createdAt} > NOW() - INTERVAL '10 minutes'`
            ));

          logger.info(`📅 [ElevenLabs Webhook] Checking ${recentAppointments.length} recent appointments for linking to call ${callRecord.id}`);

          for (const appointment of recentAppointments) {
            // Try matching by conversation ID first
            const apptConvId = appointment.metadata?.elevenLabsConversationId || appointment.metadata?.conversationId;
            const convIdMatches = apptConvId && conversation_id && apptConvId === conversation_id;

            // Match by normalized phone number (last 10 digits)
            // This handles cases where AI might transcribe phone slightly differently
            const appointmentPhone = normalizePhone(appointment.contactPhone);
            const phoneMatches = appointmentPhone && normalizedCallPhone && appointmentPhone === normalizedCallPhone;

            // Also accept fuzzy match: if 9 of 10 digits match (allows for 1 transcription error)
            const fuzzyPhoneMatch = appointmentPhone && normalizedCallPhone &&
              appointmentPhone.length === 10 && normalizedCallPhone.length === 10 &&
              appointmentPhone.split('').filter((d, i) => d === normalizedCallPhone[i]).length >= 9;

            // Agent ID match: for incoming calls where phone may be unavailable,
            // match by agent ID if there's only 1 unlinked appointment in the window
            const agentIdMatch = appointment.metadata?.elevenLabsAgentId && agent_id &&
              appointment.metadata.elevenLabsAgentId === agent_id;

            if (convIdMatches || phoneMatches || fuzzyPhoneMatch || (agentIdMatch && recentAppointments.length === 1)) {
              logger.info(`📅 [ElevenLabs Webhook] Found appointment ${appointment.id} booked during call - linking and updating metadata`);
              logger.info(`   Matches: convId=${!!convIdMatches}, phone=${phoneMatches}, fuzzy=${fuzzyPhoneMatch}, agentId=${agentIdMatch}`);
              logger.info(`   Call phone: [redacted], Appointment phone: [redacted]`);

              // Link appointment to this call
              await db
                .update(appointments)
                .set({ callId: callRecord.id })
                .where(eq(appointments.id, appointment.id));

              // Update call metadata to indicate appointment was booked (deep merge)
              const existingMetadata = (callRecord.metadata as Record<string, unknown>) || {};
              const existingAiInsights = (existingMetadata.aiInsights as Record<string, unknown>) || {};

              const appointmentMetadata = {
                ...existingMetadata,
                appointmentBooked: true,
                hasAppointment: true,
                appointmentData: {
                  appointmentId: appointment.id,
                  contactName: appointment.contactName,
                  contactPhone: appointment.contactPhone,
                  date: appointment.appointmentDate,
                  time: appointment.appointmentTime,
                  bookedAt: appointment.createdAt?.toISOString(),
                },
                aiInsights: {
                  ...existingAiInsights,
                  primaryOutcome: 'appointment_booked',
                  appointmentBooked: true,
                },
              };

              await db
                .update(calls)
                .set({ metadata: appointmentMetadata })
                .where(eq(calls.id, callRecord.id));

              // Update our local reference so CRM processor sees the updated metadata
              callRecord.metadata = appointmentMetadata;

              logger.info(`✅ [ElevenLabs Webhook] Linked appointment ${appointment.id} to call ${callRecord.id}`);
              break; // Only link one appointment per call
            }
          }
        }
      } catch (appointmentLinkError: any) {
        logger.error(`⚠️ [ElevenLabs Webhook] Error checking for appointments:`, appointmentLinkError.message);
        // Don't fail the webhook - this is a non-critical enhancement
      }

      // Refresh appointment tool date context for incoming agents (background, non-blocking)
      // This ensures the tool has the current date for "tomorrow" calculations on the next call
      if (callRecord.callDirection === 'incoming' && agent_id) {
        import('../../services/elevenlabs').then(({ ElevenLabsService }) => {
          // Find the agent's credential to create the service
          import('../../services/elevenlabs-pool').then(({ ElevenLabsPoolService }) => {
            db.select({ elevenLabsCredentialId: agents.elevenLabsCredentialId })
              .from(agents)
              .where(eq(agents.elevenLabsAgentId, agent_id))
              .limit(1)
              .then(async ([agentRow]) => {
                if (agentRow?.elevenLabsCredentialId) {
                  const credential = await ElevenLabsPoolService.getCredentialById(agentRow.elevenLabsCredentialId);
                  if (credential?.apiKey) {
                    const service = new ElevenLabsService(credential.apiKey);
                    await service.refreshAppointmentToolWithCurrentDate(agent_id);
                    logger.info(`📅 [ElevenLabs Webhook] Refreshed appointment tool date for incoming agent ${agent_id}`);
                  }
                }
              }).catch(() => { });
          }).catch(() => { });
        }).catch(() => { });
      }

      // Run violation detection in the background (don't await to avoid slowing webhook response)
      const transcriptToScan = syncedData.transcript || callRecord.transcript;
      if (transcriptToScan && callRecord.userId) {
        // Run both banned word detection and AI analysis in background
        Promise.all([
          import('../../services/violation-detection').then(({ detectViolations }) =>
            detectViolations(callRecord.id, callRecord.userId!, transcriptToScan)
          ),
          import('../../services/ai-violation-detection').then(({ analyzeTranscriptWithAI }) =>
            analyzeTranscriptWithAI(callRecord.id, callRecord.userId!, transcriptToScan)
          )
        ]).then(([bannedWordViolations, aiViolations]) => {
          const totalViolations = bannedWordViolations.length + aiViolations.length;
          if (totalViolations > 0) {
            logger.info(`🔍 [Violation Detection] Call ${callRecord.id}: ${bannedWordViolations.length} banned word + ${aiViolations.length} AI violations detected`);
          }
        }).catch((err) => {
          logger.error(`❌ [Violation Detection] Error scanning call ${callRecord.id}:`, err.message);
        });
      }

      // CRITICAL: Deduct credits for the completed call
      const callDuration = syncedData.duration || metadata?.call_duration_secs || 0;
      if (callDuration > 0) {
        try {
          const creditResult = await deductCallCreditsForElevenLabs(callRecord.id, callDuration);

          if (creditResult.success || creditResult.alreadyDeducted) {
            logger.info(`💳 [ElevenLabs Webhook] Credit deduction processed for call: ${callRecord.id}`);

            // Process call for CRM lead creation (run in background)
            import('../../engines/crm/lead-processor.service').then(({ CRMLeadProcessor }) => {
              CRMLeadProcessor.processElevenLabsTwilioCall(callRecord.id)
                .then((result) => {
                  if (result?.leadId) {
                    logger.info(`📋 [CRM] Lead created from call ${callRecord.id}: ${result.leadId} (${result.qualification.category})`);
                  } else if (result) {
                    logger.info(`📋 [CRM] Call ${callRecord.id} did not qualify for CRM lead`);
                  }
                })
                .catch((err) => {
                  logger.error(`❌ [CRM] Error processing call ${callRecord.id} for lead:`, err.message);
                });
            }).catch((err) => {
              logger.error(`❌ [CRM] Failed to import lead processor:`, err.message);
            });

          } else {
            logger.error(`❌ [ElevenLabs Webhook] Credit deduction failed for call ${callRecord.id}: ${creditResult.error}`);

            // Mark call as failed due to insufficient credits
            await db.update(calls)
              .set({
                status: 'failed',
                metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true, creditError: creditResult.error })}`
              })
              .where(eq(calls.id, callRecord.id));

            logger.warn(`⚠️ [ElevenLabs Webhook] Call ${callRecord.id} marked as failed due to credit deduction failure`);

            // CRITICAL: Stop all downstream processing when credits fail
            return res.status(200).json({
              success: false,
              error: 'Credit deduction failed',
              callId: callRecord.id
            });
          }
        } catch (creditError: any) {
          logger.error(`❌ [ElevenLabs Webhook] Credit deduction error:`, creditError.message);
        }
      } else {
        logger.warn(`⚠️ [ElevenLabs Webhook] Skipping credit deduction - no duration available`);
      }

      // Update flow execution status if one exists for this call
      try {
        const [flowExecution] = await db
          .select()
          .from(flowExecutions)
          .where(eq(flowExecutions.callId, callRecord.id))
          .limit(1);

        if (flowExecution) {
          // Extract collected variables from transcript analysis if available
          let collectedVariables = flowExecution.variables as Record<string, any> || {};

          // Try to extract variables from data_collection (ElevenLabs primary field)
          if (analysis?.data_collection && typeof analysis.data_collection === 'object') {
            collectedVariables = {
              ...collectedVariables,
              ...analysis.data_collection
            };
          }

          // Try to extract variables from data_collection_results if present (alternate field)
          if (analysis?.data_collection_results && typeof analysis.data_collection_results === 'object') {
            collectedVariables = {
              ...collectedVariables,
              ...analysis.data_collection_results
            };
          }

          // Try to extract variables from call_successful_data_collection if present
          if (analysis?.call_successful_data_collection && typeof analysis.call_successful_data_collection === 'object') {
            collectedVariables = {
              ...collectedVariables,
              ...analysis.call_successful_data_collection
            };
          }

          // Also check for collected_data at root level of webhook payload
          if (data?.collected_data && typeof data.collected_data === 'object') {
            collectedVariables = {
              ...collectedVariables,
              ...data.collected_data
            };
          }

          // Determine status based on call outcome
          let executionStatus = 'completed';
          let executionError: string | null = null;

          // Check if call was successful or failed
          if (analysis?.call_successful === false) {
            executionStatus = 'failed';
            executionError = analysis?.error_message || 'Call did not complete successfully';
          }

          // Update flow execution with collected data
          // Note: pathTaken is NOT updated - ElevenLabs runs flows natively and doesn't provide step-by-step path data
          // The path can only be reliably tracked when we control the flow execution (not implemented)
          await db
            .update(flowExecutions)
            .set({
              status: executionStatus,
              completedAt: new Date(),
              variables: collectedVariables,
              error: executionError,
              metadata: {
                ...(flowExecution.metadata as object || {}),
                callDuration: syncedData.duration || metadata?.call_duration_secs,
                callSuccessful: analysis?.call_successful,
                conversationId: callRecord.elevenLabsConversationId,
              },
            })
            .where(eq(flowExecutions.id, flowExecution.id));

          logger.info(`✅ [ElevenLabs Webhook] Updated flow execution: ${flowExecution.id} -> ${executionStatus}`);
        }
      } catch (flowExecError: any) {
        logger.error(`⚠️ [ElevenLabs Webhook] Error updating flow execution:`, flowExecError.message);
      }

      // Trigger post-call messaging for ALL completed calls regardless of credit path (fire-and-forget)
      {
        // For outbound calls the agent's own number is the FROM; send message to the customer (TO number).
        // IMPORTANT: for outbound we ONLY use the TO number; if it is unavailable we skip messaging
        // entirely rather than falling back to the FROM/agent number.
        const isOutboundCall = (callRecord.callDirection || '').includes('out');
        const agentFromNumber = syncedData.phoneNumber || callRecord.fromNumber || callRecord.phoneNumber;
        let callerPhone: string | null | undefined;
        if (isOutboundCall) {
          const toNumber = syncedData.calledNumber || callRecord.toNumber;
          // Guard: skip if TO resolves to the same number as FROM (agent's own line).
          // Normalize both to digits-only before comparing so "+1555…" ≡ "1555…".
          const toDigits = (toNumber || '').replace(/[^0-9]/g, '');
          const fromDigits = (agentFromNumber || '').replace(/[^0-9]/g, '');
          if (toNumber && toDigits.length >= 6 && toDigits !== fromDigits) {
            callerPhone = toNumber;
          } else {
            callerPhone = null; // Suppress to prevent messaging the agent's own number.
          }
        } else {
          callerPhone = syncedData.phoneNumber || callRecord.phoneNumber || callRecord.fromNumber;
        }
        if (callerPhone && callRecord.userId) {
          import('../../services/post-call-messaging').then(({ triggerPostCallMessaging }) => {
            triggerPostCallMessaging({
              elevenLabsAgentId: agent_id,
              userId: callRecord.userId!,
              callerPhone,
              callId: callRecord.id,
            }).catch(err => logger.error(`❌ [Post-Call Messaging] Regular call error: ${err.message}`));
          }).catch(err => logger.error(`❌ [Post-Call Messaging] Import error: ${err.message}`));
        }
      }

      // Trigger user webhook for completed call
      if (callRecord.userId) {
        const finalDuration = updates.duration || callRecord.duration || callDuration;
        const finalFromNumber = updates.fromNumber || callRecord.fromNumber || null;
        const finalToNumber = updates.toNumber || callRecord.toNumber || null;
        const finalPhoneNumber = updates.phoneNumber || callRecord.phoneNumber || null;
        const finalRecordingUrl = updates.recordingUrl || callRecord.recordingUrl || null;
        const finalTranscript = updates.transcript || callRecord.transcript || null;
        const finalAiSummary = updates.aiSummary || callRecord.aiSummary || null;
        const finalClassification = updates.classification || callRecord.classification || null;
        const finalSentiment = updates.sentiment || callRecord.sentiment || null;

        triggerCallCompletedWebhook({
          userId: callRecord.userId,
          companyId: (callRecord as any).companyId ?? (callRecord as any).company_id ?? null,
          callId: callRecord.id,
          callDirection: callRecord.callDirection || (callRecord.callDirection === 'incoming' ? 'inbound' : 'outbound'),
          duration: finalDuration,
          fromNumber: finalFromNumber,
          toNumber: finalToNumber,
          phoneNumber: finalPhoneNumber,
          twilioSid: updates.twilioSid || callRecord.twilioSid || null,
          recordingUrl: finalRecordingUrl,
          transcript: finalTranscript,
          aiSummary: finalAiSummary,
          classification: finalClassification,
          sentiment: finalSentiment,
          startedAt: callRecord.startedAt || null,
          endedAt: updates.endedAt || callRecord.endedAt || null,
          agentId: agent_id || callRecord.agentId || callRecord.incomingAgentId || null,
          campaignId: callRecord.campaignId || null,
          contactId: callRecord.contactId || null,
          isSipCall: false,
        }).catch(err => logger.error(`❌ [Webhook] Error triggering completed call webhook:`, err.message));
      }

    } catch (syncError: any) {
      logger.error(`❌ [ElevenLabs Webhook] Error syncing call data:`, syncError);

      // Still update the call as completed even if sync failed
      await db
        .update(calls)
        .set({
          status: 'completed',
          endedAt: new Date(),
          metadata: {
            ...callRecord.metadata as object,
            webhookProcessingError: syncError.message,
          }
        })
        .where(eq(calls.id, callRecord.id));
    }

    await recordWebhookReceived('elevenlabs');
    res.sendStatus(200);
}
