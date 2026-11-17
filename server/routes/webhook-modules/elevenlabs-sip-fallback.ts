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
import { calls, appointments } from '../../../shared/schema';
import { and, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { triggerCallCompletedWebhook } from '../webhooks/helpers';
import { deductSipCallCredits } from '../../services/credit-service';
import { checkAndDisconnectIfLowCredits } from '../../services/sip-credit-guard';
import { linkPendingAppointments } from './twilio-call-helpers';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';

export async function handleSipFallback(res: Response, ctx: ElevenLabsWebhookCtx, agent: any): Promise<any> {
  const { type, data, agent_id, conversation_id, status, webhookTranscript, metadata, analysis, customerPhone, callDirection, extractedFromNumber, extractedToNumber } = ctx;
          // CASE 0.5: SIP phone number fallback - check if phone is a SIP number even if agent doesn't have elevenlabs-sip provider
          // This catches calls where the SIP phone number is configured but agent's telephonyProvider isn't set correctly
          // SECURITY: Only proceed if we have agent context to ensure proper tenant scoping
          // ISOLATION: Wrapped in try/catch so failures here never block CASE 1/2 from creating call records
          try {
            if (agent && agent.userId) {
              // Normalize to digits only for comparison
              const extractedFromDigits = extractedFromNumber ? extractedFromNumber.replace(/[^0-9]/g, '') : '';
              const extractedToDigits = extractedToNumber ? extractedToNumber.replace(/[^0-9]/g, '') : '';

              // Only proceed if we have valid phone numbers with at least 10 digits (to avoid false matches)
              const validFromDigits = extractedFromDigits.length >= 10 ? extractedFromDigits : '';
              const validToDigits = extractedToDigits.length >= 10 ? extractedToDigits : '';

              if (!validFromDigits && !validToDigits) {
                logger.warn(`📞 [ElevenLabs SIP Fallback] Skipping - no valid phone numbers (from: ${extractedFromDigits.length} digits, to: ${extractedToDigits.length} digits)`);
              } else {

                // Look for SIP phone number scoped to the agent's user
                // This ensures tenant isolation - we only match SIP numbers belonging to this user
                const sipPhoneResult = await db.execute(sql`
              SELECT sp.*, st.user_id as trunk_user_id
              FROM sip_phone_numbers sp
              LEFT JOIN sip_trunks st ON sp.sip_trunk_id = st.id
              WHERE sp.is_active = true
              AND (
                -- Exact suffix match: last 10 digits must match exactly
                (${validFromDigits} != '' AND RIGHT(REGEXP_REPLACE(sp.phone_number, '[^0-9]', '', 'g'), 10) = RIGHT(${validFromDigits}, 10))
                OR
                (${validToDigits} != '' AND RIGHT(REGEXP_REPLACE(sp.phone_number, '[^0-9]', '', 'g'), 10) = RIGHT(${validToDigits}, 10))
              )
              -- TENANT SCOPING: Only match SIP numbers belonging to this user's trunks
              AND st.user_id::text = ${agent.userId}::text
              LIMIT 1
            `);

                const matchedSipPhone = sipPhoneResult.rows[0] as any;

                if (matchedSipPhone) {
                  logger.info(`📞 [ElevenLabs SIP Fallback] Found SIP phone number: [redacted] (user: ${agent.userId})`);

                  const direction = metadata?.phone_call?.direction || 'inbound';
                  const callDuration = metadata?.call_duration_secs || 0;
                  const terminationReason = metadata?.termination_reason || null;
                  const errorInfo = metadata?.error || null;

                  // FIX: Correct From/To for SIP calls based on resolved sipPhoneNumber
                  let sipFallbackFrom = extractedFromNumber;
                  let sipFallbackTo = extractedToNumber;
                  const sipFbDigits = matchedSipPhone.phone_number.replace(/[^0-9]/g, '');
                  const sipFbFromDigits = sipFallbackFrom ? sipFallbackFrom.replace(/[^0-9]/g, '') : '';
                  const sipFbToDigits = sipFallbackTo ? sipFallbackTo.replace(/[^0-9]/g, '') : '';
                  const sipFbFromIsSip = sipFbFromDigits && (sipFbDigits.endsWith(sipFbFromDigits) || sipFbFromDigits.endsWith(sipFbDigits));
                  const sipFbToIsSip = sipFbToDigits && (sipFbDigits.endsWith(sipFbToDigits) || sipFbToDigits.endsWith(sipFbDigits));

                  if (direction === 'inbound' && sipFbFromIsSip && !sipFbToIsSip) {
                    logger.info(`   🔄 Correcting inbound SIP Fallback From/To swap`);
                    const temp = sipFallbackFrom;
                    sipFallbackFrom = sipFallbackTo;
                    sipFallbackTo = temp || matchedSipPhone.phone_number;
                  } else if (direction === 'outbound' && sipFbToIsSip && !sipFbFromIsSip) {
                    logger.info(`   🔄 Correcting outbound SIP Fallback From/To swap`);
                    const temp = sipFallbackTo;
                    sipFallbackTo = sipFallbackFrom;
                    sipFallbackFrom = temp || matchedSipPhone.phone_number;
                  }

                  // Check for existing SIP call record
                  const existingSipCallResult = await db.execute(sql`
                SELECT * FROM sip_calls WHERE elevenlabs_conversation_id = ${conversation_id} OR external_call_id = ${conversation_id} LIMIT 1
              `);
                  const existingSipCall = existingSipCallResult.rows[0] as any;

                  if (existingSipCall) {
                    // Status downgrade protection
                    const terminalStatuses = ['completed', 'failed'];
                    if (terminalStatuses.includes(existingSipCall.status)) {
                      logger.warn(`   SIP call already in terminal status '${existingSipCall.status}' - skipping update`);
                      return res.sendStatus(200);
                    }
                  }

                  // Get transcript data
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

                  // Determine final status
                  const resolvedStatus = (syncedData as any).status || status;
                  const isCompletedCall = resolvedStatus === 'completed' || resolvedStatus === 'done' || type === 'post_call_transcription' || type === 'post_call_transcription_otel';
                  const isFailedCall = resolvedStatus === 'failed' || resolvedStatus === 'error' || resolvedStatus === 'timeout' || resolvedStatus === 'no-answer' || !!errorInfo;
                  const finalStatus = isCompletedCall ? 'completed' : (isFailedCall ? 'failed' : (resolvedStatus || 'in-progress'));

                  const resolvedDuration = syncedData.duration || callDuration || 0;
                  const resolvedFromNumber = syncedData.phoneNumber || sipFallbackFrom || null;
                  const resolvedToNumber = syncedData.calledNumber || sipFallbackTo || null;

                  const endedAt = new Date();
                  const startedAt = new Date(endedAt.getTime() - (resolvedDuration * 1000));

                  // Find the associated agent
                  const agentForSip = agent || null;
                  const userId = matchedSipPhone.trunk_user_id || matchedSipPhone.user_id || agentForSip?.userId;

                  if (!userId) {
                    logger.warn(`⚠️ [ElevenLabs SIP Fallback] Could not determine user for SIP call`);
                    return res.sendStatus(200);
                  }

                  if (existingSipCall) {
                    // Update existing record with corrected from/to
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
                      terminationReason,
                      error: errorInfo,
                    })}::jsonb,
                    recording_url = ${syncedData.recordingUrl || null},
                    ai_summary = ${syncedData.aiSummary || null},
                    started_at = COALESCE(started_at, ${startedAt}),
                    ended_at = ${endedAt},
                    updated_at = NOW()
                  WHERE id = ${existingSipCall.id}
                `);
                    logger.info(`✅ [ElevenLabs SIP Fallback] Updated SIP call record: ${existingSipCall.id} (status: ${finalStatus}, sentiment: ${syncedData.sentiment || 'N/A'}, classification: ${syncedData.classification || 'N/A'})`);

                    // Credit check + deduction for completed calls only
                    if (isCompletedCall && resolvedDuration > 0 && !errorInfo) {
                      const { checkUserCreditBalance } = await import('../../services/credit-service');
                      const creditCheck = await checkUserCreditBalance(userId);

                      if (!creditCheck.hasCredits) {
                        logger.error(`🚫 [ElevenLabs SIP Fallback] User has 0 credits - marking call ${existingSipCall.id} as credit_failed`);
                        await db.execute(sql`
                      UPDATE sip_calls SET status = 'credit_failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true, creditError: 'Insufficient credits', creditBalance: 0 })}::jsonb,
                        updated_at = NOW()
                      WHERE id = ${existingSipCall.id}
                    `);
                        const { notifyCreditFailure } = await import('../../services/credit-service');
                        notifyCreditFailure({
                          userId,
                          callId: existingSipCall.id,
                          creditsRequired: Math.max(1, Math.ceil(resolvedDuration / 60)),
                          currentBalance: 0,
                          durationSeconds: resolvedDuration,
                        });
                      } else {
                        const creditResult = await deductSipCallCredits(existingSipCall.id, resolvedDuration, 'elevenlabs-sip');
                        if (creditResult.success || creditResult.alreadyDeducted) {
                          logger.info(`✅ [ElevenLabs SIP Fallback] Credits deducted: ${creditResult.creditsDeducted}`);

                          checkAndDisconnectIfLowCredits(userId).catch(err =>
                            logger.error(`[SIP Credit Guard] Error: ${err.message}`)
                          );

                          import('../../engines/crm/lead-processor.service').then(({ CRMLeadProcessor }) => {
                            CRMLeadProcessor.processSipCall(existingSipCall.id)
                              .then((result) => {
                                if (result?.leadId) {
                                  logger.info(`📋 [CRM] Lead created from SIP call ${existingSipCall.id}: ${result.leadId} (${result.qualification.category})`);
                                }
                              })
                              .catch((err) => {
                                logger.error(`❌ [CRM] Error processing SIP call for lead:`, err.message);
                              });
                          }).catch(() => { });
                        } else {
                          await db.execute(sql`
                        UPDATE sip_calls SET status = 'credit_failed',
                          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true })}::jsonb,
                          updated_at = NOW()
                        WHERE id = ${existingSipCall.id}
                      `);
                        }
                      }
                    } else if (errorInfo) {
                      logger.error(`⚠️ [ElevenLabs SIP Fallback] Skipping credit deduction due to error: ${JSON.stringify(errorInfo)}`);
                    }

                    // Trigger post-call messaging for completed SIP calls (fire-and-forget)
                    if (isCompletedCall && agentForSip) {
                      const isOutboundSip = direction === 'outbound';
                      let sipMessagePhone: string | null = null;
                      if (isOutboundSip) {
                        const toNumber = resolvedToNumber || sipFallbackTo;
                        const toDigits = (toNumber || '').replace(/[^0-9]/g, '');
                        const fromDigits = (resolvedFromNumber || sipFallbackFrom || '').replace(/[^0-9]/g, '');
                        if (toNumber && toNumber !== 'N/A' && toNumber !== 'Unknown' && toDigits.length >= 6 && toDigits !== fromDigits) {
                          sipMessagePhone = toNumber;
                        }
                      } else {
                        const fromNumber = resolvedFromNumber || sipFallbackFrom;
                        if (fromNumber && fromNumber !== 'N/A' && fromNumber !== 'Unknown') {
                          sipMessagePhone = fromNumber;
                        }
                      }

                      if (sipMessagePhone) {
                        import('../../services/post-call-messaging').then(({ triggerPostCallMessaging }) => {
                          triggerPostCallMessaging({
                            elevenLabsAgentId: agentForSip.id,
                            userId: userId,
                            callerPhone: sipMessagePhone!,
                            callId: existingSipCall.id,
                          }).catch(err => logger.error(`❌ [Post-Call Messaging] SIP update fallback error: ${err.message}`));
                        }).catch(err => logger.error(`❌ [Post-Call Messaging] Import error: ${err.message}`));
                      }
                    }

                    // Trigger webhook for completed SIP call
                    if (isCompletedCall && userId) {
                      triggerCallCompletedWebhook({
                        userId,
                        companyId: existingSipCall.company_id ?? null,
                        callId: existingSipCall.id,
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
                        startedAt: existingSipCall.started_at || startedAt,
                        endedAt: endedAt,
                        agentId: agent_id || existingSipCall.agent_id || null,
                        isSipCall: true,
                      }).catch(err => logger.error(`❌ [Webhook] SIP completed call webhook error:`, err.message));
                    }
                  } else {
                    const resolvedFallbackFrom = resolvedFromNumber || 'Unknown';
                    const resolvedFallbackTo = resolvedToNumber || matchedSipPhone.phone_number;

                    const sipCallResult = await db.execute(sql`
                  INSERT INTO sip_calls (
                    user_id, agent_id, sip_trunk_id, sip_phone_number_id,
                    engine, elevenlabs_conversation_id, from_number, to_number,
                    direction, status, duration_seconds, transcript, sentiment, classification, metadata,
                    recording_url, ai_summary, started_at, ended_at
                  )
                  VALUES (
                    ${userId}, ${agentForSip?.id || null}, ${matchedSipPhone.sipTrunkId || matchedSipPhone.sip_trunk_id}, ${matchedSipPhone.id},
                    'elevenlabs-sip', ${conversation_id}, ${resolvedFallbackFrom}, ${resolvedFallbackTo},
                    ${direction}, ${finalStatus}, ${resolvedDuration}, 
                    ${syncedData.rawTranscript ? JSON.stringify(syncedData.rawTranscript) : null}::jsonb,
                    ${syncedData.sentiment || null},
                    ${syncedData.classification || null},
                    ${JSON.stringify({
                      analysis,
                      classification: syncedData.classification,
                      sentiment: syncedData.sentiment,
                      agentName: agentForSip?.name || 'Unknown',
                      terminationReason,
                      error: errorInfo,
                    })}::jsonb,
                    ${syncedData.recordingUrl || null},
                    ${syncedData.aiSummary || null},
                    ${startedAt}, ${endedAt}
                  )
                  RETURNING *
                `);

                    const sipCallRecord = sipCallResult.rows[0] as any;
                    logger.info(`✅ [ElevenLabs SIP Fallback] Created SIP call record: ${sipCallRecord?.id} (status: ${finalStatus}, sentiment: ${syncedData.sentiment || 'N/A'}, classification: ${syncedData.classification || 'N/A'})`);

                    // Link pending appointments created during this conversation
                    await linkPendingAppointments({
                      userId,
                      callId: sipCallRecord.id,
                      conversationId: conversation_id,
                      phoneNumber: resolvedFallbackFrom || undefined,
                      isSipCall: true,
                    });

                    // Credit check + deduction for completed calls only
                    if (isCompletedCall && resolvedDuration > 0 && sipCallRecord?.id && !errorInfo) {
                      const { checkUserCreditBalance } = await import('../../services/credit-service');
                      const creditCheck = await checkUserCreditBalance(userId);

                      if (!creditCheck.hasCredits) {
                        logger.error(`🚫 [ElevenLabs SIP Fallback] User has 0 credits - marking call ${sipCallRecord.id} as credit_failed`);
                        await db.execute(sql`
                      UPDATE sip_calls SET status = 'credit_failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true, creditError: 'Insufficient credits', creditBalance: 0 })}::jsonb,
                        updated_at = NOW()
                      WHERE id = ${sipCallRecord.id}
                    `);
                        const { notifyCreditFailure } = await import('../../services/credit-service');
                        notifyCreditFailure({
                          userId,
                          callId: sipCallRecord.id,
                          creditsRequired: Math.max(1, Math.ceil(resolvedDuration / 60)),
                          currentBalance: 0,
                          durationSeconds: resolvedDuration,
                        });
                      } else {
                        const creditResult = await deductSipCallCredits(sipCallRecord.id, resolvedDuration, 'elevenlabs-sip');
                        if (creditResult.success || creditResult.alreadyDeducted) {
                          logger.info(`✅ [ElevenLabs SIP Fallback] Credits deducted: ${creditResult.creditsDeducted}`);

                          checkAndDisconnectIfLowCredits(userId).catch(err =>
                            logger.error(`[SIP Credit Guard] Error: ${err.message}`)
                          );

                          import('../../engines/crm/lead-processor.service').then(({ CRMLeadProcessor }) => {
                            CRMLeadProcessor.processSipCall(sipCallRecord.id)
                              .then((result) => {
                                if (result?.leadId) {
                                  logger.info(`📋 [CRM] Lead created from SIP call ${sipCallRecord.id}: ${result.leadId} (${result.qualification.category})`);
                                }
                              })
                              .catch((err) => {
                                logger.error(`❌ [CRM] Error processing SIP call for lead:`, err.message);
                              });
                          }).catch(() => { });
                        } else {
                          await db.execute(sql`
                        UPDATE sip_calls SET status = 'credit_failed',
                          metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true })}::jsonb,
                          updated_at = NOW()
                        WHERE id = ${sipCallRecord.id}
                      `);
                        }
                      }
                    } else if (errorInfo) {
                      logger.error(`⚠️ [ElevenLabs SIP Fallback] Skipping credit deduction due to error: ${JSON.stringify(errorInfo)}`);
                    }

                    // Trigger post-call messaging for completed SIP calls (fire-and-forget)
                    if (isCompletedCall && agentForSip && sipCallRecord?.id) {
                      const isOutboundSip = direction === 'outbound';
                      let sipMessagePhone: string | null = null;
                      if (isOutboundSip) {
                        const toNumber = resolvedToNumber || sipFallbackTo;
                        const toDigits = (toNumber || '').replace(/[^0-9]/g, '');
                        const fromDigits = (resolvedFromNumber || sipFallbackFrom || '').replace(/[^0-9]/g, '');
                        if (toNumber && toNumber !== 'N/A' && toNumber !== 'Unknown' && toDigits.length >= 6 && toDigits !== fromDigits) {
                          sipMessagePhone = toNumber;
                        }
                      } else {
                        const fromNumber = resolvedFromNumber || sipFallbackFrom;
                        if (fromNumber && fromNumber !== 'N/A' && fromNumber !== 'Unknown') {
                          sipMessagePhone = fromNumber;
                        }
                      }

                      if (sipMessagePhone) {
                        import('../../services/post-call-messaging').then(({ triggerPostCallMessaging }) => {
                          triggerPostCallMessaging({
                            elevenLabsAgentId: agentForSip.id,
                            userId: userId,
                            callerPhone: sipMessagePhone!,
                            callId: sipCallRecord.id,
                          }).catch(err => logger.error(`❌ [Post-Call Messaging] SIP create fallback error: ${err.message}`));
                        }).catch(err => logger.error(`❌ [Post-Call Messaging] Import error: ${err.message}`));
                      }
                    }

                    // Trigger webhook for completed SIP call
                    if (isCompletedCall && sipCallRecord && userId) {
                      triggerCallCompletedWebhook({
                        userId,
                        companyId: sipCallRecord.company_id ?? null,
                        callId: sipCallRecord.id,
                        callDirection: direction || 'inbound',
                        duration: resolvedDuration,
                        fromNumber: resolvedFallbackFrom,
                        toNumber: resolvedFallbackTo,
                        phoneNumber: resolvedFallbackFrom,
                        recordingUrl: syncedData.recordingUrl || null,
                        transcript: syncedData.transcript || null,
                        aiSummary: syncedData.aiSummary || null,
                        classification: syncedData.classification || null,
                        sentiment: syncedData.sentiment || null,
                        startedAt: startedAt,
                        endedAt: endedAt,
                        agentId: agentForSip?.id || null,
                        isSipCall: true,
                      }).catch(err => logger.error(`❌ [Webhook] SIP completed call webhook error:`, err.message));
                    }
                  }

                  return res.sendStatus(200);
                }
              } // Close the else block (valid phone digits)
            }
          } catch (sipFallbackError: any) {
            logger.warn(`⚠️ [ElevenLabs SIP Fallback] Error in SIP phone lookup (non-fatal, continuing to CASE 1/2): ${sipFallbackError.message}`);
          }
}
