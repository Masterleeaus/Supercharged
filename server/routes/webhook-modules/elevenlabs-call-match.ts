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
import { calls, campaigns, agents } from '../../../shared/schema';
import { eq, and, or, inArray, isNull, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { flowExecutions } from '@shared/schema';
import { isTypeMismatchError } from './webhook-shared';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';

export async function matchCallRecordFallback(ctx: ElevenLabsWebhookCtx): Promise<void> {
  const { agent_id, conversation_id, status, metadata, customerPhone, extractedFromNumber, extractedToNumber } = ctx;
    // If no record found by conversation_id, try matching by phone number + agent for batch calls
    // Batch calls are pre-created with status='pending' and matching phone numbers
    // NOTE: Campaign scheduler may mark calls as 'failed' before this webhook arrives,
    // so we also search for 'failed' and 'in_progress' statuses
    if (!ctx.callRecord && agent_id) {
      logger.info(`📞 [ElevenLabs Webhook] No record by conversation_id - attempting phone number match for batch calls`);

      const webhookPhoneNumber = extractedToNumber || extractedFromNumber || customerPhone;

      if (webhookPhoneNumber) {
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.elevenLabsAgentId, agent_id))
          .limit(1);

        if (agent && (agent.type === 'natural' || agent.type === 'flow')) {
          logger.info(`   Found campaign agent: ${agent.name} (${agent.type})`);
          logger.info(`   Looking for batch call to: [redacted]`);

          try {
            const webhookPhoneNoPlus = webhookPhoneNumber.replace(/^\+/, '');
            const webhookPhoneWithPlus = '+' + webhookPhoneNoPlus;

            const pendingCallQuery = await db
              .select({ call: calls, campaign: campaigns })
              .from(calls)
              .leftJoin(campaigns, eq(calls.campaignId, campaigns.id))
              .where(
                and(
                  or(
                    eq(calls.phoneNumber, webhookPhoneNumber),
                    eq(calls.phoneNumber, webhookPhoneNoPlus),
                    eq(calls.phoneNumber, webhookPhoneWithPlus)
                  ),
                  inArray(calls.status, [
                    'pending',
                    'failed',
                    'in_progress',
                    'in-progress',
                    'answered',
                    'ringing',
                    'initiated',
                    'queued',
                  ]),
                  eq(calls.callDirection, 'outgoing'),
                  eq(campaigns.agentId, agent.id)
                )
              )
              .orderBy(sql`${calls.createdAt} DESC`)
              .limit(20);

            if (pendingCallQuery.length > 0) {
              const targetDigits = webhookPhoneNumber.replace(/[^\d]/g, '');
              const matchedRow = pendingCallQuery.find(row => {
                const dbDigits = (row.call.phoneNumber || '').replace(/[^\d]/g, '');
                return dbDigits === targetDigits || dbDigits.endsWith(targetDigits) || targetDigits.endsWith(dbDigits);
              });

              if (matchedRow && matchedRow.call) {
                ctx.callRecord = matchedRow.call;
                logger.info(`   ✅ Found matching pre-created batch call record: ${ctx.callRecord.id} (status: ${ctx.callRecord.status})`);
              }
            }

            if (!ctx.callRecord) {
              logger.info(`   No batch call found by phone number formats for [redacted]`);
            }
          } catch (pendingQueryError: any) {
            if (isTypeMismatchError(pendingQueryError)) {
              logger.warn(`[ElevenLabs Webhook] Type mismatch on pending call lookup, retrying with raw SQL and uuid casting`);
              try {
                const webhookPhoneNoPlus = webhookPhoneNumber.replace(/^\+/, '');
                const rawResult = await db.execute(sql`
                  SELECT c.* FROM calls c
                  LEFT JOIN campaigns camp ON c.campaign_id::text = camp.id::text
                  WHERE (c.phone_number = ${webhookPhoneNumber} OR c.phone_number = ${webhookPhoneNoPlus})
                    AND c.status IN ('pending', 'failed', 'in_progress', 'in-progress', 'answered', 'ringing', 'initiated', 'queued')
                    AND c.call_direction = 'outgoing'
                    AND camp.agent_id::text = ${agent.id}::text
                  ORDER BY c.created_at DESC
                  LIMIT 1
                `);
                if (rawResult.rows && rawResult.rows.length > 0) {
                  ctx.callRecord = rawResult.rows[0] as any;
                  logger.info(`   ✅ Found batch call via raw SQL: ${ctx.callRecord.id} (status: ${ctx.callRecord.status})`);
                } else {
                  logger.info(`   No batch call found by phone number (raw SQL) for [redacted]`);
                }
              } catch (rawQueryError: any) {
                logger.error(`   ❌ Raw SQL pending call lookup also failed:`, rawQueryError.message);
              }
            } else {
              logger.error(`   ❌ Pending call lookup error:`, pendingQueryError.message);
            }
          }

          if (ctx.callRecord) {
            try {
              await db
                .update(calls)
                .set({ elevenLabsConversationId: conversation_id })
                .where(eq(calls.id, ctx.callRecord.id));
              logger.info(`   Updated call record with conversation_id: ${conversation_id}`);
            } catch (updateConvIdError: any) {
              if (isTypeMismatchError(updateConvIdError)) {
                try {
                  await db.execute(sql`UPDATE calls SET elevenlabs_conversation_id = ${conversation_id} WHERE id::text = ${ctx.callRecord.id}::text`);
                  logger.info(`   Updated call record with conversation_id (raw SQL): ${conversation_id}`);
                } catch (rawUpdateErr: any) {
                  logger.warn(`   ⚠️ Failed to set conversation_id (non-fatal):`, rawUpdateErr.message);
                }
              } else {
                logger.warn(`   ⚠️ Failed to set conversation_id (non-fatal):`, updateConvIdError.message);
              }
            }
          }
        }
      }

      // FALLBACK: Try matching by batch_call_id if phone number match failed
      // Batch calls have batchJobId stored in call record metadata
      if (!ctx.callRecord && metadata?.batch_call?.batch_call_id) {
        const batchCallId = metadata.batch_call.batch_call_id;
        const webhookPhone = extractedToNumber || extractedFromNumber || customerPhone;
        logger.info(`   Attempting batch_call_id match: ${batchCallId}, phone: [redacted]`);

        try {
          const batchCallQuery = await db
            .select()
            .from(calls)
            .where(
              and(
                inArray(calls.status, [
                  'pending',
                  'failed',
                  'in_progress',
                  'in-progress',
                  'answered',
                  'ringing',
                  'initiated',
                  'queued',
                ]),
                eq(calls.callDirection, 'outgoing'),
                isNull(calls.elevenLabsConversationId),
                sql`${calls.metadata}->>'batchJobId' = ${batchCallId}`
              )
            )
            .orderBy(sql`${calls.createdAt} DESC`)
            .limit(20);

          logger.info(`   Found ${batchCallQuery.length} calls for batch_call_id ${batchCallId}`);

          if (batchCallQuery.length > 0) {
            if (webhookPhone) {
              const normalizedWebhookPhone = webhookPhone.replace(/[^\d]/g, '');
              const exactMatch = batchCallQuery.find(c => {
                const normalizedCallPhone = c.phoneNumber?.replace(/[^\d]/g, '') || '';
                return normalizedCallPhone === normalizedWebhookPhone ||
                  normalizedCallPhone.endsWith(normalizedWebhookPhone) ||
                  normalizedWebhookPhone.endsWith(normalizedCallPhone);
              });
              if (exactMatch) {
                ctx.callRecord = exactMatch;
                logger.info(`   ✅ Found batch call by batch_call_id + phone: ${ctx.callRecord.id}`);
              }
            }

            if (!ctx.callRecord) {
              ctx.callRecord = batchCallQuery[0];
              logger.info(`   ✅ Found batch call by batch_call_id (first match): ${ctx.callRecord.id}`);
            }

            try {
              await db
                .update(calls)
                .set({ elevenLabsConversationId: conversation_id })
                .where(eq(calls.id, ctx.callRecord.id));
              logger.info(`   Updated call record with conversation_id: ${conversation_id}`);
            } catch (updateConvIdError: any) {
              if (isTypeMismatchError(updateConvIdError)) {
                try {
                  await db.execute(sql`UPDATE calls SET elevenlabs_conversation_id = ${conversation_id} WHERE id::text = ${ctx.callRecord.id}::text`);
                  logger.info(`   Updated call record with conversation_id (raw SQL): ${conversation_id}`);
                } catch (rawUpdateErr: any) {
                  logger.warn(`   ⚠️ Failed to set conversation_id (non-fatal):`, rawUpdateErr.message);
                }
              } else {
                logger.warn(`   ⚠️ Failed to set conversation_id (non-fatal):`, updateConvIdError.message);
              }
            }
          } else {
            logger.info(`   No calls found for batch_call_id: ${batchCallId}`);
          }
        } catch (batchQueryError: any) {
          logger.error(`   ❌ Batch call ID lookup error:`, batchQueryError.message);
        }
      }
    }
}

export async function updateFlowExecutionToRunning(ctx: ElevenLabsWebhookCtx): Promise<void> {
  const { conversation_id, status, metadata } = ctx;
    // Update flow execution to 'running' status when call is matched
    if (ctx.callRecord) {
      try {
        const [flowExecution] = await db
          .select()
          .from(flowExecutions)
          .where(eq(flowExecutions.callId, ctx.callRecord.id))
          .limit(1);

        if (flowExecution && flowExecution.status === 'pending') {
          await db
            .update(flowExecutions)
            .set({
              status: 'running',
              startedAt: new Date(),
              metadata: sql`COALESCE(${flowExecutions.metadata}, '{}'::jsonb) || ${JSON.stringify({ conversationId: conversation_id })}::jsonb`,
            })
            .where(eq(flowExecutions.id, flowExecution.id));
          logger.info(`🔀 [ElevenLabs Webhook] Flow execution ${flowExecution.id} started (pending -> running)`);
        }
      } catch (flowExecError: any) {
        logger.warn(`⚠️ [ElevenLabs Webhook] Error updating flow execution to running:`, flowExecError.message);
      }
    }
}
