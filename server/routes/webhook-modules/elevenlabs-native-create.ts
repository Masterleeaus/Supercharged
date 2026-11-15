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
import { calls, campaigns, phoneNumbers, incomingConnections } from '../../../shared/schema';
import { nanoid } from 'nanoid';
import { eq, and, or, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { flowExecutions } from '@shared/schema';
import { isTypeMismatchError } from './webhook-shared';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';

export async function handleCampaignFallbackCreate(res: Response, ctx: ElevenLabsWebhookCtx, agent: any): Promise<any> {
  const { data, agent_id, conversation_id, status, webhookTranscript, metadata, analysis, callDirection, extractedFromNumber, extractedToNumber, extractedCallSid } = ctx;
          // CASE 1: Outbound campaign/flow agent - create fallback record
          // This handles cases where batch call record wasn't pre-created or phone format mismatch
          if (agent && (agent.type === 'natural' || agent.type === 'flow')) {
            logger.info(`   Found campaign agent: ${agent.name} (${agent.type})`);

            // Use extracted phone number (already checked all nested locations)
            const webhookPhoneNumber = extractedToNumber || extractedFromNumber;

            if (webhookPhoneNumber) {
              logger.warn(`   Creating fallback outbound call record for: [redacted]`);

              // Find a campaign using this agent
              let campaignMatch: any = null;
              try {
                const [cm] = await db
                  .select()
                  .from(campaigns)
                  .where(eq(campaigns.agentId, agent.id))
                  .orderBy(sql`${campaigns.startedAt} DESC NULLS LAST`)
                  .limit(1);
                campaignMatch = cm;
              } catch (campaignLookupErr: any) {
                if (isTypeMismatchError(campaignLookupErr)) {
                  logger.warn(`[ElevenLabs Webhook] Type mismatch on campaign lookup, retrying with raw SQL`);
                  const cmResult = await db.execute(sql`
                    SELECT * FROM campaigns WHERE agent_id::text = ${agent.id}::text
                    ORDER BY started_at DESC NULLS LAST LIMIT 1
                  `);
                  campaignMatch = cmResult.rows[0] as any;
                } else {
                  logger.warn(`[ElevenLabs Webhook] Campaign lookup failed:`, campaignLookupErr.message);
                }
              }

              // Use sync service to get combined data
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

              // Provider webhooks carry no session, so company comes from the owning agent record.
              // Fail closed: refuse rather than insert a row without company_id.
              const companyId: string | null = agent.companyId ?? null;
              if (!companyId) {
                logger.warn(`[ElevenLabs Webhook] Refusing fallback outbound call insert: agent ${agent.id} has no company_id`);
                return res.sendStatus(403);
              }

              // Create fallback call record with proper user ownership
              const outboundCallValues = {
                userId: campaignMatch?.userId || campaignMatch?.user_id || agent.userId,
                companyId,
                campaignId: campaignMatch?.id || null,
                contactId: null,
                phoneNumber: syncedData.phoneNumber || webhookPhoneNumber,
                fromNumber: extractedFromNumber || null,
                toNumber: extractedToNumber || webhookPhoneNumber || null,
                status: 'completed',
                callDirection: 'outgoing',
                elevenLabsConversationId: conversation_id,
                twilioSid: extractedCallSid || null,
                duration: syncedData.duration,
                transcript: syncedData.transcript,
                aiSummary: syncedData.aiSummary,
                classification: syncedData.classification,
                recordingUrl: syncedData.recordingUrl,
                endedAt: new Date(),
                metadata: {
                  ...syncedData.metadata,
                  agentName: agent.name,
                  agentType: agent.type,
                  createdFromWebhook: true,
                  fallbackRecord: true,
                },
              };

              let newCallRecord;
              try {
                [newCallRecord] = await db
                  .insert(calls)
                  .values(outboundCallValues)
                  .returning();
              } catch (insertError: any) {
                if (isTypeMismatchError(insertError)) {
                  logger.warn(`[ElevenLabs Webhook] Type mismatch on outbound INSERT, retrying with raw SQL and uuid casting`);
                  const metadataJson = JSON.stringify(outboundCallValues.metadata);
                  const rawResult = await db.execute(sql`
                    INSERT INTO calls (
                      company_id, user_id, campaign_id, contact_id, phone_number, from_number, to_number,
                      status, call_direction, elevenlabs_conversation_id, twilio_sid,
                      duration, transcript, ai_summary, classification, recording_url, ended_at, metadata
                    ) VALUES (
                      ${companyId}::uuid, ${outboundCallValues.userId}::text, ${outboundCallValues.campaignId}::text, NULL,
                      ${outboundCallValues.phoneNumber}, ${outboundCallValues.fromNumber}, ${outboundCallValues.toNumber},
                      ${outboundCallValues.status}, ${outboundCallValues.callDirection},
                      ${outboundCallValues.elevenLabsConversationId}, ${outboundCallValues.twilioSid},
                      ${outboundCallValues.duration}::int, ${outboundCallValues.transcript}, ${outboundCallValues.aiSummary},
                      ${outboundCallValues.classification}, ${outboundCallValues.recordingUrl},
                      ${outboundCallValues.endedAt}, ${metadataJson}::jsonb
                    ) RETURNING *
                  `);
                  newCallRecord = rawResult.rows[0] as any;
                } else {
                  throw insertError;
                }
              }

              ctx.callRecord = newCallRecord;
              logger.info(`✅ [ElevenLabs Webhook] Created fallback outbound call record: ${ctx.callRecord.id}`);

              // Create flow execution record for flow-based fallback calls
              if (agent.flowId) {
                try {
                  const { nanoid } = await import('nanoid');
                  const executionId = nanoid();
                  await db.insert(flowExecutions).values({
                    id: executionId,
                    companyId,
                    callId: ctx.callRecord.id,
                    flowId: agent.flowId,
                    currentNodeId: null,
                    status: 'completed', // Fallback calls are already completed
                    variables: analysis?.data_collection || {},
                    pathTaken: [],
                    startedAt: new Date(),
                    completedAt: new Date(),
                    metadata: {
                      campaignId: campaignMatch?.id || null,
                      campaignName: campaignMatch?.name || null,
                      contactPhone: webhookPhoneNumber,
                      nativeExecution: true,
                      telephonyProvider: 'elevenlabs',
                      fallbackRecord: true,
                      conversationId: conversation_id,
                    },
                  });
                  logger.info(`🔀 [ElevenLabs Webhook] Created flow execution for fallback call: ${executionId}`);
                } catch (flowExecError: any) {
                  logger.warn(`⚠️ [ElevenLabs Webhook] Error creating flow execution for fallback:`, flowExecError.message);
                }
              }
            }
          }
}

export async function handleIncomingCallCreate(res: Response, ctx: ElevenLabsWebhookCtx, agent: any): Promise<any> {
  const { data, agent_id, conversation_id, status, webhookTranscript, metadata, analysis, callDirection, extractedFromNumber, extractedToNumber, extractedCallSid } = ctx;
          // CASE 2: Incoming agent - create new incoming call record
          if (!ctx.callRecord && agent && agent.type === 'incoming') {
            logger.info(`   Found incoming agent: ${agent.name}`);

            // USE EXTRACTED PHONE NUMBERS (already checked all nested locations: phone_call, batch_call, direct)
            const callerPhoneNumber = extractedFromNumber;
            const calledNumber = extractedToNumber;

            logger.info(`   Using extracted phone data - From: [redacted], To: [redacted]`);

            // CRITICAL: Find the incoming connection by the CALLED phone number (to_number)
            // This ensures we link to the correct connection when an agent has multiple
            let connection: any = null;

            try {
              if (calledNumber) {
                const [matchedConnection] = await db
                  .select({
                    id: incomingConnections.id,
                    phoneNumberId: incomingConnections.phoneNumberId,
                    userId: incomingConnections.userId,
                    phoneNumber: {
                      phoneNumber: phoneNumbers.phoneNumber,
                      friendlyName: phoneNumbers.friendlyName,
                    }
                  })
                  .from(incomingConnections)
                  .leftJoin(phoneNumbers, eq(incomingConnections.phoneNumberId, phoneNumbers.id))
                  .where(
                    and(
                      eq(incomingConnections.agentId, agent.id),
                      eq(phoneNumbers.phoneNumber, calledNumber)
                    )
                  )
                  .limit(1);

                connection = matchedConnection;
              }

              if (!connection) {
                const [fallbackConnection] = await db
                  .select({
                    id: incomingConnections.id,
                    phoneNumberId: incomingConnections.phoneNumberId,
                    userId: incomingConnections.userId,
                    phoneNumber: {
                      phoneNumber: phoneNumbers.phoneNumber,
                      friendlyName: phoneNumbers.friendlyName,
                    }
                  })
                  .from(incomingConnections)
                  .leftJoin(phoneNumbers, eq(incomingConnections.phoneNumberId, phoneNumbers.id))
                  .where(eq(incomingConnections.agentId, agent.id))
                  .limit(1);

                connection = fallbackConnection;
                if (connection) {
                  logger.warn(`   ⚠️ Using fallback connection - could not match by phone number`);
                }
              }
            } catch (connLookupError: any) {
              if (isTypeMismatchError(connLookupError)) {
                logger.warn(`[ElevenLabs Webhook] Type mismatch on connection lookup, retrying with raw SQL and uuid casting`);
                try {
                  const connQuery = calledNumber
                    ? sql`SELECT ic.id, ic.phone_number_id AS "phoneNumberId", ic.user_id AS "userId",
                           pn.phone_number AS "phoneNumber", pn.friendly_name AS "friendlyName"
                         FROM incoming_connections ic
                         LEFT JOIN phone_numbers pn ON ic.phone_number_id::text = pn.id::text
                         WHERE ic.agent_id::text = ${agent.id}::text AND pn.phone_number = ${calledNumber}
                         LIMIT 1`
                    : sql`SELECT ic.id, ic.phone_number_id AS "phoneNumberId", ic.user_id AS "userId",
                           pn.phone_number AS "phoneNumber", pn.friendly_name AS "friendlyName"
                         FROM incoming_connections ic
                         LEFT JOIN phone_numbers pn ON ic.phone_number_id::text = pn.id::text
                         WHERE ic.agent_id::text = ${agent.id}::text
                         LIMIT 1`;
                  const connResult = await db.execute(connQuery);
                  if (connResult.rows.length > 0) {
                    const row = connResult.rows[0] as any;
                    connection = {
                      id: row.id,
                      phoneNumberId: row.phoneNumberId,
                      userId: row.userId,
                      phoneNumber: { phoneNumber: row.phoneNumber, friendlyName: row.friendlyName },
                    };
                  }
                } catch (rawSqlError: any) {
                  logger.warn(`[ElevenLabs Webhook] Raw SQL connection lookup also failed:`, rawSqlError.message);
                }
              } else {
                logger.warn(`[ElevenLabs Webhook] Connection lookup failed:`, connLookupError.message);
              }
            }

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

            // Use synced phone number (from Twilio or ElevenLabs) - fallback to 'Unknown Caller' if not available
            const finalPhoneNumber = syncedData.phoneNumber || callerPhoneNumber || 'Unknown Caller';
            const finalCalledNumber = syncedData.calledNumber || calledNumber || connection?.phoneNumber?.phoneNumber || 'Unknown';

            // Create call record even if phone number is unknown - data is valuable
            // CRITICAL: Always ensure userId is populated for proper user data isolation
            // Priority: connection owner > agent owner (never null)
            const resolvedUserId = connection?.userId || agent.userId;
            if (!resolvedUserId) {
              logger.warn(`   ⚠️ Cannot determine userId - call will have orphaned ownership`);
            }

            logger.info(`   Creating incoming call record with:`);
            logger.info(`     Phone: [redacted]`);
            logger.info(`     Called: ${finalCalledNumber}`);
            logger.info(`     Duration: ${syncedData.duration || metadata?.call_duration_secs || 'N/A'}s`);
            logger.info(`     Transcript: ${syncedData.transcript ? 'present' : 'N/A'}`);
            logger.info(`     AI Summary: ${syncedData.aiSummary ? 'present' : 'N/A'}`);

            // Provider webhooks carry no session, so company comes from the owning agent record.
            // Fail closed: refuse rather than insert a row without company_id.
            const companyId: string | null = agent.companyId ?? null;
            if (!companyId) {
              logger.warn(`[ElevenLabs Webhook] Refusing incoming call insert: agent ${agent.id} has no company_id`);
              return res.sendStatus(403);
            }

            let newCallRecord;
            const callValues = {
              userId: resolvedUserId,
              companyId,
              campaignId: null,
              contactId: null,
              incomingConnectionId: connection?.id || null,
              incomingAgentId: null,
              phoneNumber: finalPhoneNumber,
              fromNumber: finalPhoneNumber,
              toNumber: finalCalledNumber,
              status: 'completed',
              callDirection: 'incoming',
              elevenLabsConversationId: conversation_id,
              twilioSid: extractedCallSid || null,
              duration: syncedData.duration || metadata?.call_duration_secs || null,
              transcript: syncedData.transcript,
              aiSummary: syncedData.aiSummary,
              classification: syncedData.classification,
              recordingUrl: syncedData.recordingUrl,
              endedAt: new Date(),
              metadata: {
                ...syncedData.metadata,
                incomingAgentName: agent.name,
                calledNumber: finalCalledNumber,
                agentType: 'incoming',
                createdFromWebhook: true,
                connectionMatched: !!connection && !!calledNumber,
                webhookMetadata: metadata,
              },
            };

            try {
              [newCallRecord] = await db
                .insert(calls)
                .values(callValues)
                .returning();
            } catch (insertError: any) {
              if (isTypeMismatchError(insertError)) {
                logger.warn(`[ElevenLabs Webhook] Type mismatch on incoming INSERT, retrying with raw SQL and uuid casting`);
                const metadataJson = JSON.stringify(callValues.metadata);
                const rawResult = await db.execute(sql`
                  INSERT INTO calls (
                    company_id, user_id, campaign_id, contact_id, incoming_connection_id, incoming_agent_id,
                    phone_number, from_number, to_number, status, call_direction,
                    elevenlabs_conversation_id, twilio_sid, duration, transcript, ai_summary,
                    classification, recording_url, ended_at, metadata
                  ) VALUES (
                    ${companyId}::uuid, ${callValues.userId}::text, NULL, NULL, ${callValues.incomingConnectionId}::text, NULL,
                    ${callValues.phoneNumber}, ${callValues.fromNumber}, ${callValues.toNumber},
                    ${callValues.status}, ${callValues.callDirection},
                    ${callValues.elevenLabsConversationId}, ${callValues.twilioSid},
                    ${callValues.duration}::int, ${callValues.transcript}, ${callValues.aiSummary},
                    ${callValues.classification}, ${callValues.recordingUrl},
                    ${callValues.endedAt}, ${metadataJson}::jsonb
                  ) RETURNING *
                `);
                newCallRecord = rawResult.rows[0] as any;
              } else {
                throw insertError;
              }
            }

            ctx.callRecord = newCallRecord;
            logger.info(`✅ [ElevenLabs Webhook] Created incoming call record: ${ctx.callRecord.id}`);
          }
}
