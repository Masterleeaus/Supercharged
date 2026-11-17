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
import { calls, agents, appointments, sipPhoneNumbers } from '../../../shared/schema';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { recordWebhookReceived } from '../../engines/payment/webhook-helper';
import { triggerCallCompletedWebhook } from '../webhooks/helpers';
import { deductSipCallCredits } from '../../services/credit-service';
import { checkAndDisconnectIfLowCredits } from '../../services/sip-credit-guard';
import { linkPendingAppointments } from './twilio-call-helpers';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';

export async function handleSipCase0(res: Response, ctx: ElevenLabsWebhookCtx, agent: any): Promise<any> {
  const { type, data, agent_id, conversation_id, status, webhookTranscript, metadata, analysis, customerPhone, callDirection, agentNumber, extractedFromNumber, extractedToNumber } = ctx;
          // CASE 0: ElevenLabs SIP calls - create/update record in sip_calls table
          // This handles calls through user's own SIP trunk via ElevenLabs
          // ISOLATION: Wrapped in try/catch so failures never block other CASE branches
          try {
            if (agent && agent.telephonyProvider === 'elevenlabs-sip') {
              logger.info(`📞 [ElevenLabs SIP] Found SIP agent: ${agent.name}`);

              let callerPhoneNumber = extractedFromNumber;
              let calledNumber = extractedToNumber;
              const direction = metadata?.phone_call?.direction || 'inbound';
              const callDuration = metadata?.call_duration_secs || 0;

              // Fallback for OTel webhooks where metadata is flat/absent
              if (!callerPhoneNumber && !calledNumber && customerPhone) {
                if (direction === 'inbound') {
                  callerPhoneNumber = customerPhone;
                } else {
                  calledNumber = customerPhone;
                }
              }

              logger.info(`   SIP Call - Direction: ${direction}, From: [redacted], To: [redacted]`);

              // BATCH CAMPAIGN INTERCEPT: For SIP agents, batch campaign calls are stored in
              // the `calls` table (not sip_calls). Check for a matching batch campaign call
              // BEFORE going through the SIP call creation flow.
              try {
                const batchCallResult = await db
                  .select()
                  .from(calls)
                  .where(
                    and(
                      sql`${calls.metadata}->>'elevenLabsAgentId' = ${agent_id}`,
                      sql`${calls.metadata}->>'batchCall' = 'true'`,
                      eq(calls.callDirection, 'outgoing'),
                      isNull(calls.elevenLabsConversationId)
                    )
                  )
                  .orderBy(sql`${calls.createdAt} DESC`)
                  .limit(20);

                if (batchCallResult.length > 0) {
                  // Try phone number matching if we have phone data
                  const webhookPhone = calledNumber || callerPhoneNumber || extractedToNumber || extractedFromNumber || customerPhone;
                  let matchedBatchCall = null;

                  if (webhookPhone && webhookPhone !== 'N/A') {
                    const targetDigits = webhookPhone.replace(/[^\d]/g, '');
                    if (targetDigits) {
                      matchedBatchCall = batchCallResult.find(c => {
                        const dbDigits = (c.phoneNumber || '').replace(/[^\d]/g, '');
                        return dbDigits === targetDigits || dbDigits.endsWith(targetDigits) || targetDigits.endsWith(dbDigits);
                      });
                    }
                  }

                  if (matchedBatchCall) {
                    logger.info(`📞 [ElevenLabs SIP] Found matching batch campaign call: ${matchedBatchCall.id} (status: ${matchedBatchCall.status}, phone: [redacted])`);

                    // Link conversation_id and update status
                    const updateData: Record<string, any> = {
                      elevenLabsConversationId: conversation_id,
                    };

                    // If the call was prematurely failed by expireRemainingPendingCalls, rescue it
                    // post_call_transcription webhook = call completed on ElevenLabs
                    if (matchedBatchCall.status === 'failed' || matchedBatchCall.status === 'pending') {
                      updateData.status = 'completed';
                      logger.info(`   ✅ Rescuing batch call from '${matchedBatchCall.status}' → 'completed'`);
                    }

                    await db
                      .update(calls)
                      .set(updateData)
                      .where(eq(calls.id, matchedBatchCall.id));

                    // Trigger full sync for transcript, summary, recording
                    const { callSyncService } = await import('../../services/call-sync');
                    callSyncService.syncCall(matchedBatchCall.id).catch(syncErr => {
                      logger.error(`❌ [ElevenLabs SIP] Background sync failed for batch call ${matchedBatchCall!.id}:`, syncErr.message);
                    });

                    logger.info(`✅ [ElevenLabs SIP] Linked batch call ${matchedBatchCall.id} to conversation ${conversation_id}, sync triggered`);
                    await recordWebhookReceived('elevenlabs');
                    return res.sendStatus(200);
                  } else {
                    logger.info(`   [ElevenLabs SIP] No matching batch campaign call found by phone number — proceeding with SIP call flow`);
                  }
                } else {
                  logger.info(`   [ElevenLabs SIP] No unlinked batch campaign calls found — proceeding with SIP call flow`);
                }
              } catch (batchInterceptErr: any) {
                logger.error(`   [ElevenLabs SIP] Batch intercept error (non-fatal): ${batchInterceptErr.message}`);
                // Continue with normal SIP flow on error
              }

              // First, check if there's an existing sip_calls record (for outbound calls)
              const existingSipCallResult = await db.execute(sql`
              SELECT * FROM sip_calls WHERE elevenlabs_conversation_id = ${conversation_id} OR external_call_id = ${conversation_id} LIMIT 1
            `);
              const existingSipCall = existingSipCallResult.rows[0] as any;

              if (existingSipCall) {
                logger.info(`   Found existing SIP call record: ${existingSipCall.id} (${existingSipCall.direction})`);

                // Status downgrade protection: Don't update if already in terminal state
                const terminalStatuses = ['completed', 'failed'];
                if (terminalStatuses.includes(existingSipCall.status)) {
                  logger.warn(`   SIP call already in terminal status '${existingSipCall.status}' - skipping update`);
                  return res.sendStatus(200);
                }

                // FIX: Correct From/To for existing SIP calls using the stored sip_phone_number_id
                // Resolve the SIP phone number from the existing record to run swap detection
                if (existingSipCall.sip_phone_number_id) {
                  try {
                    const existingSipPhoneResult = await db.execute(sql`
                    SELECT phone_number FROM sip_phone_numbers WHERE id::text = ${existingSipCall.sip_phone_number_id}::text LIMIT 1
                  `);
                    const existingSipPhone = existingSipPhoneResult.rows[0] as any;
                    if (existingSipPhone?.phone_number) {
                      const normalizeForCompare = (phone: string) => phone.replace(/[^0-9]/g, '');
                      const sipDigits = normalizeForCompare(existingSipPhone.phone_number);
                      const fDigits = callerPhoneNumber ? normalizeForCompare(callerPhoneNumber) : '';
                      const tDigits = calledNumber ? normalizeForCompare(calledNumber) : '';
                      const fIsSip = fDigits && (sipDigits.endsWith(fDigits) || fDigits.endsWith(sipDigits));
                      const tIsSip = tDigits && (sipDigits.endsWith(tDigits) || tDigits.endsWith(sipDigits));

                      if (direction === 'inbound' && fIsSip && !tIsSip) {
                        logger.info(`   🔄 Correcting existing inbound SIP From/To swap`);
                        const temp = callerPhoneNumber;
                        callerPhoneNumber = calledNumber;
                        calledNumber = temp || existingSipPhone.phone_number;
                      } else if (direction === 'outbound' && tIsSip && !fIsSip) {
                        logger.info(`   🔄 Correcting existing outbound SIP From/To swap`);
                        const temp = calledNumber;
                        calledNumber = callerPhoneNumber;
                        callerPhoneNumber = temp || existingSipPhone.phone_number;
                      }
                    }
                  } catch (err) {
                    logger.warn(`   ⚠️ Could not resolve SIP phone for swap correction: ${err}`);
                  }
                }

                // Use sync service to get transcript and analysis data
                const { callSyncService } = await import('../../services/call-sync');
                const syncedData = await callSyncService.syncFromWebhook({
                  conversationId: conversation_id,
                  agentId: agent_id,
                  transcript: webhookTranscript,
                  analysis,
                  metadata,
                  status,
                  callDurationSecs: callDuration,
                  customerPhone: customerPhone || undefined,
                });

                // Determine final status based on webhook status
                const resolvedStatus = (syncedData as any).status || status;
                const isCompletedCall = resolvedStatus === 'completed' || resolvedStatus === 'done' || type === 'post_call_transcription' || type === 'post_call_transcription_otel';
                const isFailedCall = resolvedStatus === 'failed' || resolvedStatus === 'error' || resolvedStatus === 'timeout' || resolvedStatus === 'no-answer';
                const finalStatus = isCompletedCall ? 'completed' : (isFailedCall ? 'failed' : (resolvedStatus || 'in-progress'));

                const resolvedDuration = syncedData.duration || callDuration || 0;
                const resolvedFromNumber = syncedData.phoneNumber || callerPhoneNumber || null;
                const resolvedToNumber = syncedData.calledNumber || calledNumber || null;

                // Calculate proper started_at from ended_at - duration
                const endedAt = new Date();
                const startedAt = new Date(endedAt.getTime() - (resolvedDuration * 1000));

                // Update existing record with call completion data and corrected from/to
                await db.execute(sql`
                UPDATE sip_calls SET
                  status = ${finalStatus},
                  duration_seconds = ${resolvedDuration},
                  from_number = COALESCE(${resolvedFromNumber}, from_number),
                  to_number = COALESCE(${resolvedToNumber}, to_number),
                  transcript = ${syncedData.rawTranscript ? JSON.stringify(syncedData.rawTranscript) : null}::jsonb,
                  sentiment = ${syncedData.sentiment || null},
                  classification = ${syncedData.classification || null},
                  metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
                  ...syncedData.metadata,
                  analysis: syncedData.metadata?.elevenLabsAnalysis || analysis || null,
                  aiSummary: syncedData.aiSummary,
                  classification: syncedData.classification,
                  sentiment: syncedData.sentiment,
                  recordingUrl: syncedData.recordingUrl,
                })}::jsonb,
                  recording_url = ${syncedData.recordingUrl || null},
                  ai_summary = ${syncedData.aiSummary || null},
                  started_at = COALESCE(started_at, ${startedAt}),
                  ended_at = ${endedAt},
                  updated_at = NOW()
                WHERE id = ${existingSipCall.id}
              `);
                logger.info(`✅ [ElevenLabs SIP] Updated SIP call record: ${existingSipCall.id} (status: ${finalStatus}, sentiment: ${syncedData.sentiment || 'N/A'}, classification: ${syncedData.classification || 'N/A'})`);

                // Pre-call credit balance check for existing SIP calls
                if (isCompletedCall && resolvedDuration > 0) {
                  const { checkUserCreditBalance } = await import('../../services/credit-service');
                  const creditCheck = await checkUserCreditBalance(existingSipCall.user_id);

                  if (!creditCheck.hasCredits) {
                    logger.error(`🚫 [ElevenLabs SIP] User has 0 credits - marking call ${existingSipCall.id} as credit_failed`);
                    await db.execute(sql`
                    UPDATE sip_calls SET 
                      status = 'credit_failed',
                      metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true, creditError: 'Insufficient credits', creditBalance: 0 })}::jsonb,
                      updated_at = NOW()
                    WHERE id = ${existingSipCall.id}
                  `);
                    const { notifyCreditFailure } = await import('../../services/credit-service');
                    notifyCreditFailure({
                      userId: existingSipCall.user_id,
                      callId: existingSipCall.id,
                      creditsRequired: Math.max(1, Math.ceil(resolvedDuration / 60)),
                      currentBalance: 0,
                      durationSeconds: resolvedDuration,
                    });
                    return res.sendStatus(200);
                  }

                  logger.info(`💳 [ElevenLabs SIP] Processing credit deduction for ${resolvedDuration}s call`);
                  const creditResult = await deductSipCallCredits(existingSipCall.id, resolvedDuration, 'elevenlabs-sip');
                  if (creditResult.success || creditResult.alreadyDeducted) {
                    logger.info(`✅ [ElevenLabs SIP] Credits deducted: ${creditResult.creditsDeducted}`);

                    checkAndDisconnectIfLowCredits(existingSipCall.user_id).catch(err =>
                      logger.error(`[SIP Credit Guard] Error: ${err.message}`)
                    );

                    import('../../engines/crm/lead-processor.service').then(({ CRMLeadProcessor }) => {
                      CRMLeadProcessor.processSipCall(existingSipCall.id)
                        .then((result) => {
                          if (result?.leadId) {
                            logger.info(`📋 [CRM] Lead created from SIP call ${existingSipCall.id}: ${result.leadId} (${result.qualification.category})`);
                          } else if (result) {
                            logger.info(`📋 [CRM] SIP call ${existingSipCall.id} did not qualify for CRM lead`);
                          }
                        })
                        .catch((err) => {
                          logger.error(`❌ [CRM] Error processing SIP call ${existingSipCall.id} for lead:`, err.message);
                        });
                    }).catch((err) => {
                      logger.error(`❌ [CRM] Failed to import lead processor:`, err.message);
                    });
                  } else {
                    logger.error(`❌ [ElevenLabs SIP] Credit deduction failed: ${creditResult.error}`);
                    await db.execute(sql`
                    UPDATE sip_calls SET 
                      status = 'credit_failed',
                      metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true })}::jsonb,
                      updated_at = NOW()
                    WHERE id = ${existingSipCall.id}
                  `);
                  }
                } else if (!isCompletedCall) {
                  logger.info(`⚠️ [ElevenLabs SIP] Call ${finalStatus} - no credit deduction`);
                }

                // Trigger post-call messaging for completed SIP calls (fire-and-forget)
                const isOutboundSip = direction === 'outbound';
                let sipMessagePhone: string | null = null;
                if (isOutboundSip) {
                  const toNumber = resolvedToNumber || calledNumber;
                  const toDigits = (toNumber || '').replace(/[^0-9]/g, '');
                  const fromDigits = (resolvedFromNumber || callerPhoneNumber || '').replace(/[^0-9]/g, '');
                  if (toNumber && toNumber !== 'N/A' && toNumber !== 'Unknown' && toDigits.length >= 6 && toDigits !== fromDigits) {
                    sipMessagePhone = toNumber;
                  }
                } else {
                  const fromNumber = resolvedFromNumber || callerPhoneNumber;
                  if (fromNumber && fromNumber !== 'N/A' && fromNumber !== 'Unknown') {
                    sipMessagePhone = fromNumber;
                  }
                }

                if (isCompletedCall && sipMessagePhone) {
                  import('../../services/post-call-messaging').then(({ triggerPostCallMessaging }) => {
                    triggerPostCallMessaging({
                      elevenLabsAgentId: agent_id,
                      userId: existingSipCall.user_id,
                      callerPhone: sipMessagePhone!,
                      callId: existingSipCall.id,
                    }).catch(err => logger.error(`❌ [Post-Call Messaging] SIP update error: ${err.message}`));
                  }).catch(err => logger.error(`❌ [Post-Call Messaging] Import error: ${err.message}`));
                }

                // Trigger webhook for completed SIP call
                if (isCompletedCall && existingSipCall.user_id) {
                  triggerCallCompletedWebhook({
                    userId: existingSipCall.user_id,
                    companyId: existingSipCall.company_id ?? null,
                    callId: existingSipCall.id,
                    callDirection: existingSipCall.direction || direction || 'inbound',
                    duration: resolvedDuration,
                    fromNumber: resolvedFromNumber,
                    toNumber: resolvedToNumber,
                    phoneNumber: resolvedFromNumber,
                    recordingUrl: syncedData.recordingUrl || null,
                    transcript: syncedData.transcript || null,
                    aiSummary: syncedData.aiSummary || null,
                    classification: syncedData.classification || null,
                    sentiment: syncedData.sentiment || null,
                    startedAt: existingSipCall.started_at || startedAt,
                    endedAt: endedAt,
                    agentId: agent_id || existingSipCall.agent_id || null,
                    isSipCall: true,
                  }).catch(err => logger.error(`❌ [Webhook] SIP completed call webhook error:`, err.message));
                }

                return res.sendStatus(200);
              }

              // Find the SIP phone number that received/made the call
              // For SIP calls: agentNumber is ALWAYS the SIP phone number (your number)
              // Use it directly as the primary match, with fallbacks
              let sipPhoneNumber = null;
              const sipPhoneToMatch = agentNumber || (direction === 'inbound' ? calledNumber : callerPhoneNumber);

              logger.info(`   Looking for SIP phone: [redacted] (agentNumber: [redacted])`);

              if (sipPhoneToMatch) {
                const normalizeDigits = (phone: string) => phone.replace(/[^0-9]/g, '');
                const normalizedTarget = normalizeDigits(sipPhoneToMatch);

                const allSipPhones = await db
                  .select()
                  .from(sipPhoneNumbers)
                  .where(eq(sipPhoneNumbers.userId, agent.userId));

                logger.info(`   Found ${allSipPhones.length} SIP phones for user, matching against: ${normalizedTarget}`);

                sipPhoneNumber = allSipPhones.find(sp => {
                  const normalizedSp = normalizeDigits(sp.phoneNumber);
                  return normalizedSp.endsWith(normalizedTarget) || normalizedTarget.endsWith(normalizedSp);
                });

                if (sipPhoneNumber) {
                  logger.info(`   ✅ Matched SIP phone: [redacted] (ID: ${sipPhoneNumber.id})`);
                }
              }

              // Fallback: Get SIP phone from agent's sipPhoneNumberId
              if (!sipPhoneNumber && agent.sipPhoneNumberId) {
                logger.warn(`   Fallback: Using agent's sipPhoneNumberId: ${agent.sipPhoneNumberId}`);
                const [spn] = await db
                  .select()
                  .from(sipPhoneNumbers)
                  .where(eq(sipPhoneNumbers.id, agent.sipPhoneNumberId))
                  .limit(1);
                sipPhoneNumber = spn;
              }

              // Final fallback: Get SIP phone assigned to this agent
              if (!sipPhoneNumber) {
                logger.warn(`   Final fallback: Looking for SIP phone assigned to agent ${agent.id}`);
                const [spn] = await db
                  .select()
                  .from(sipPhoneNumbers)
                  .where(eq(sipPhoneNumbers.agentId, agent.id))
                  .limit(1);
                sipPhoneNumber = spn;
                if (sipPhoneNumber) {
                  logger.info(`   ✅ Found SIP phone by agent assignment: [redacted]`);
                }
              }

              if (!sipPhoneNumber) {
                logger.warn(`⚠️ [ElevenLabs SIP] Could not find SIP phone number for agent ${agent.id}`);

                // FALLBACK: For batch campaign calls, call records are in the `calls` table (not sip_calls).
                // Try to match by conversation_id or metadata.elevenLabsAgentId + phone.
                // This rescues webhooks for completed batch calls that the scheduler couldn't sync.
                try {
                  // First try matching by metadata.elevenLabsAgentId on the calls table
                  const batchFallbackResult = await db
                    .select()
                    .from(calls)
                    .where(
                      and(
                        sql`${calls.metadata}->>'elevenLabsAgentId' = ${agent_id}`,
                        sql`${calls.metadata}->>'batchCall' = 'true'`,
                        eq(calls.callDirection, 'outgoing'),
                        // Look for calls that haven't been fully synced yet
                        or(
                          isNull(calls.elevenLabsConversationId),
                          eq(calls.elevenLabsConversationId, conversation_id)
                        )
                      )
                    )
                    .orderBy(sql`${calls.createdAt} DESC`)
                    .limit(20);

                  if (batchFallbackResult.length > 0) {
                    // Try to match by phone number if available, otherwise take first match
                    const webhookPhone = extractedToNumber || extractedFromNumber;
                    let matchedCall = null;

                    if (webhookPhone) {
                      const targetDigits = webhookPhone.replace(/[^\d]/g, '');
                      matchedCall = batchFallbackResult.find(c => {
                        const dbDigits = (c.phoneNumber || '').replace(/[^\d]/g, '');
                        return dbDigits === targetDigits || dbDigits.endsWith(targetDigits) || targetDigits.endsWith(dbDigits);
                      });
                    }

                    if (!matchedCall) {
                      // Take the first call without a conversation_id
                      matchedCall = batchFallbackResult.find(c => !c.elevenLabsConversationId) || batchFallbackResult[0];
                    }

                    if (matchedCall) {
                      logger.info(`📞 [ElevenLabs SIP] Found batch campaign call record: ${matchedCall.id} (status: ${matchedCall.status})`);

                      // Update conversation_id so future webhooks can match
                      await db
                        .update(calls)
                        .set({ elevenLabsConversationId: conversation_id })
                        .where(eq(calls.id, matchedCall.id));

                      // Trigger a full sync to get transcript, summary, recording
                      const { callSyncService } = await import('../../services/call-sync');
                      callSyncService.syncCall(matchedCall.id).catch(err => {
                        logger.error(`❌ [ElevenLabs SIP] Background sync failed for batch call ${matchedCall!.id}:`, err.message);
                      });

                      logger.info(`✅ [ElevenLabs SIP] Linked batch call ${matchedCall.id} to conversation ${conversation_id}, sync triggered`);
                      return res.sendStatus(200);
                    }
                  }

                  logger.info(`   [ElevenLabs SIP] No batch campaign call match found either`);
                } catch (batchFallbackErr: any) {
                  logger.error(`   [ElevenLabs SIP] Batch call fallback error: ${batchFallbackErr.message}`);
                }

                return res.sendStatus(200);
              }

              // FIX: Correct From/To for SIP calls based on resolved sipPhoneNumber
              // ElevenLabs metadata may put the SIP phone (agent number) in 'from' and external caller in 'to'
              // For inbound calls: from_number should be the external caller, to_number should be the SIP phone
              // For outbound calls: from_number should be the SIP phone, to_number should be the external caller
              const normalizeDigitsForCompare = (phone: string) => phone.replace(/[^0-9]/g, '');
              const sipPhoneDigits = normalizeDigitsForCompare(sipPhoneNumber.phoneNumber);
              const fromDigits = callerPhoneNumber ? normalizeDigitsForCompare(callerPhoneNumber) : '';
              const toDigits = calledNumber ? normalizeDigitsForCompare(calledNumber) : '';
              const fromIsSipPhone = fromDigits && (sipPhoneDigits.endsWith(fromDigits) || fromDigits.endsWith(sipPhoneDigits));
              const toIsSipPhone = toDigits && (sipPhoneDigits.endsWith(toDigits) || toDigits.endsWith(sipPhoneDigits));

              if (direction === 'inbound' && fromIsSipPhone && !toIsSipPhone) {
                logger.info(`   🔄 Correcting inbound SIP From/To swap: SIP phone was in 'from', swapping`);
                const temp = callerPhoneNumber;
                callerPhoneNumber = calledNumber;
                calledNumber = temp || sipPhoneNumber.phoneNumber;
              } else if (direction === 'outbound' && toIsSipPhone && !fromIsSipPhone) {
                logger.info(`   🔄 Correcting outbound SIP From/To swap: SIP phone was in 'to', swapping`);
                const temp = calledNumber;
                calledNumber = callerPhoneNumber;
                callerPhoneNumber = temp || sipPhoneNumber.phoneNumber;
              }
              logger.info(`   SIP Call (corrected) - From: [redacted], To: [redacted]`);

              // Use sync service to get transcript and analysis data
              const { callSyncService } = await import('../../services/call-sync');
              const syncedData = await callSyncService.syncFromWebhook({
                conversationId: conversation_id,
                agentId: agent_id,
                transcript: webhookTranscript,
                analysis,
                metadata,
                status,
                callDurationSecs: callDuration,
                customerPhone: customerPhone || undefined,
              });

              // Determine final status based on webhook status
              const resolvedStatus = (syncedData as any).status || status;
              const isCompletedCall = resolvedStatus === 'completed' || resolvedStatus === 'done' || type === 'post_call_transcription' || type === 'post_call_transcription_otel';
              const isFailedCall = resolvedStatus === 'failed' || resolvedStatus === 'error' || resolvedStatus === 'timeout' || resolvedStatus === 'no-answer';
              const finalStatus = isCompletedCall ? 'completed' : (isFailedCall ? 'failed' : (resolvedStatus || 'in-progress'));

              const resolvedDuration = syncedData.duration || callDuration || 0;
              const resolvedFromNumber = syncedData.phoneNumber || callerPhoneNumber || 'Unknown';
              const resolvedToNumber = syncedData.calledNumber || calledNumber || sipPhoneNumber.phoneNumber;

              // Calculate proper timestamps
              const endedAt = new Date();
              const startedAt = new Date(endedAt.getTime() - (resolvedDuration * 1000));

              const sipCallResult = await db.execute(sql`
              INSERT INTO sip_calls (
                user_id, agent_id, sip_trunk_id, sip_phone_number_id,
                engine, elevenlabs_conversation_id, from_number, to_number,
                direction, status, duration_seconds, transcript, sentiment, classification, metadata,
                recording_url, ai_summary, started_at, ended_at
              )
              VALUES (
                ${agent.userId}, ${agent.id}, ${sipPhoneNumber.sipTrunkId}, ${sipPhoneNumber.id},
                'elevenlabs-sip', ${conversation_id}, ${resolvedFromNumber}, ${resolvedToNumber},
                ${direction}, ${finalStatus}, ${resolvedDuration}, 
                ${syncedData.rawTranscript ? JSON.stringify(syncedData.rawTranscript) : null}::jsonb,
                ${syncedData.sentiment || null},
                ${syncedData.classification || null},
                ${JSON.stringify({
                ...syncedData.metadata,
                analysis: syncedData.metadata?.elevenLabsAnalysis || analysis || null,
                classification: syncedData.classification,
                sentiment: syncedData.sentiment,
                agentName: agent.name
              })}::jsonb,
                ${syncedData.recordingUrl || null},
                ${syncedData.aiSummary || null},
                ${startedAt}, ${endedAt}
              )
              RETURNING *
            `);

              const sipCallRecord = sipCallResult.rows[0] as any;
              logger.info(`✅ [ElevenLabs SIP] Created SIP call record: ${sipCallRecord?.id} (status: ${finalStatus}, sentiment: ${syncedData.sentiment || 'N/A'}, classification: ${syncedData.classification || 'N/A'})`);

              // Link pending appointments created during this conversation
              await linkPendingAppointments({
                userId: agent.userId,
                callId: sipCallRecord.id,
                conversationId: conversation_id,
                phoneNumber: resolvedFromNumber || undefined,
                isSipCall: true,
              });

              // Credit balance check + deduction for completed SIP calls
              if (isCompletedCall && resolvedDuration > 0 && sipCallRecord?.id) {
                const { checkUserCreditBalance } = await import('../../services/credit-service');
                const creditCheck = await checkUserCreditBalance(agent.userId);

                if (!creditCheck.hasCredits) {
                  logger.error(`🚫 [ElevenLabs SIP] User has 0 credits - marking call ${sipCallRecord.id} as credit_failed`);
                  await db.execute(sql`
                  UPDATE sip_calls SET 
                    status = 'credit_failed',
                    metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true, creditError: 'Insufficient credits', creditBalance: 0 })}::jsonb,
                    updated_at = NOW()
                  WHERE id = ${sipCallRecord.id}
                `);
                  const { notifyCreditFailure } = await import('../../services/credit-service');
                  notifyCreditFailure({
                    userId: agent.userId,
                    callId: sipCallRecord.id,
                    creditsRequired: Math.max(1, Math.ceil(resolvedDuration / 60)),
                    currentBalance: 0,
                    durationSeconds: resolvedDuration,
                  });
                  return res.sendStatus(200);
                }

                logger.info(`💳 [ElevenLabs SIP] Processing credit deduction for ${resolvedDuration}s call`);
                const creditResult = await deductSipCallCredits(sipCallRecord.id, resolvedDuration, 'elevenlabs-sip');
                if (creditResult.success || creditResult.alreadyDeducted) {
                  logger.info(`✅ [ElevenLabs SIP] Credits deducted: ${creditResult.creditsDeducted}`);

                  checkAndDisconnectIfLowCredits(agent.userId).catch(err =>
                    logger.error(`[SIP Credit Guard] Error: ${err.message}`)
                  );

                  import('../../engines/crm/lead-processor.service').then(({ CRMLeadProcessor }) => {
                    CRMLeadProcessor.processSipCall(sipCallRecord.id)
                      .then((result) => {
                        if (result?.leadId) {
                          logger.info(`📋 [CRM] Lead created from SIP call ${sipCallRecord.id}: ${result.leadId} (${result.qualification.category})`);
                        } else if (result) {
                          logger.info(`📋 [CRM] SIP call ${sipCallRecord.id} did not qualify for CRM lead`);
                        }
                      })
                      .catch((err) => {
                        logger.error(`❌ [CRM] Error processing SIP call ${sipCallRecord.id} for lead:`, err.message);
                      });
                  }).catch((err) => {
                    logger.error(`❌ [CRM] Failed to import lead processor:`, err.message);
                  });
                } else {
                  logger.error(`❌ [ElevenLabs SIP] Credit deduction failed: ${creditResult.error}`);
                  await db.execute(sql`
                  UPDATE sip_calls SET 
                    status = 'credit_failed',
                    metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true })}::jsonb,
                    updated_at = NOW()
                  WHERE id = ${sipCallRecord.id}
                `);
                }
              } else if (!isCompletedCall) {
                logger.info(`⚠️ [ElevenLabs SIP] Call ${finalStatus} - no credit deduction`);
              }

              // Trigger post-call messaging for completed SIP calls (fire-and-forget)
              const isOutboundSip = direction === 'outbound';
              let sipMessagePhone: string | null = null;
              if (isOutboundSip) {
                const toNumber = resolvedToNumber || calledNumber;
                const toDigits = (toNumber || '').replace(/[^0-9]/g, '');
                const fromDigits = (resolvedFromNumber || callerPhoneNumber || '').replace(/[^0-9]/g, '');
                if (toNumber && toNumber !== 'N/A' && toNumber !== 'Unknown' && toDigits.length >= 6 && toDigits !== fromDigits) {
                  sipMessagePhone = toNumber;
                }
              } else {
                const fromNumber = resolvedFromNumber || callerPhoneNumber;
                if (fromNumber && fromNumber !== 'N/A' && fromNumber !== 'Unknown') {
                  sipMessagePhone = fromNumber;
                }
              }

              if (isCompletedCall && sipMessagePhone && sipCallRecord?.id) {
                import('../../services/post-call-messaging').then(({ triggerPostCallMessaging }) => {
                  triggerPostCallMessaging({
                    elevenLabsAgentId: agent_id,
                    userId: agent.userId,
                    callerPhone: sipMessagePhone!,
                    callId: sipCallRecord.id,
                  }).catch(err => logger.error(`❌ [Post-Call Messaging] SIP create error: ${err.message}`));
                }).catch(err => logger.error(`❌ [Post-Call Messaging] Import error: ${err.message}`));
              }

              // Trigger webhook for completed SIP call
              if (isCompletedCall && sipCallRecord && agent.userId) {
                triggerCallCompletedWebhook({
                  userId: agent.userId,
                  companyId: sipCallRecord.company_id ?? null,
                  callId: sipCallRecord.id,
                  callDirection: direction || 'inbound',
                  duration: resolvedDuration,
                  fromNumber: resolvedFromNumber,
                  toNumber: resolvedToNumber,
                  phoneNumber: resolvedFromNumber,
                  recordingUrl: syncedData.recordingUrl || null,
                  transcript: syncedData.transcript || null,
                  aiSummary: syncedData.aiSummary || null,
                  classification: syncedData.classification || null,
                  sentiment: syncedData.sentiment || null,
                  startedAt: startedAt,
                  endedAt: endedAt,
                  agentId: agent.id,
                  isSipCall: true,
                }).catch(err => logger.error(`❌ [Webhook] SIP completed call webhook error:`, err.message));
              }

              return res.sendStatus(200);
            }
          } catch (sipCase0Error: any) {
            logger.error(`❌ [ElevenLabs SIP CASE 0] Error processing SIP call (non-fatal, continuing): ${sipCase0Error.message}`);
          }
}
