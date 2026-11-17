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
import { Request, Response } from 'express';
import { db } from '../../db';
import { calls } from '../../../shared/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../utils/logger';
// ============================================
// FLOW-BASED EXECUTION WEBHOOKS (DEPRECATED)
// Flow Agents now execute entirely through ElevenLabs
// These stubs are kept for backward compatibility
// ============================================
import { flowExecutions } from '@shared/schema';
import { enforceWebhookRateLimit } from './webhook-shared';

export const FLOW_DEPRECATED_MESSAGE = 'Flow execution via TwiML webhooks is deprecated. Flow Agents now execute entirely through ElevenLabs. Please update your agent configuration.';

/**
 * DEPRECATED: Flow webhook handlers
 * Flow Agents now execute entirely through ElevenLabs using compiled workflows.
 * These handlers return deprecation notices for any legacy calls.
 */

export function generateDeprecationTwiML(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${FLOW_DEPRECATED_MESSAGE}</Say>
  <Hangup/>
</Response>`;
}

/**
 * Initial webhook when flow-based call is answered (DEPRECATED)
 */
export async function handleFlowVoiceAnswer(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  logger.warn(`⚠️ [Flow Answer] DEPRECATED: ${FLOW_DEPRECATED_MESSAGE}`);
  res.type('text/xml').send(generateDeprecationTwiML());
}

/**
 * Serve TwiML for a specific node (DEPRECATED)
 */
export async function handleFlowNode(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  logger.warn(`⚠️ [Flow Node] DEPRECATED: ${FLOW_DEPRECATED_MESSAGE}`);
  res.type('text/xml').send(generateDeprecationTwiML());
}

/**
 * Handle user response from Question nodes (DEPRECATED)
 */
export async function handleFlowGather(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  logger.warn(`⚠️ [Flow Gather] DEPRECATED: ${FLOW_DEPRECATED_MESSAGE}`);
  res.type('text/xml').send(generateDeprecationTwiML());
}

/**
 * Continue to next node after Message/Delay (DEPRECATED)
 */
export async function handleFlowContinue(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  logger.warn(`⚠️ [Flow Continue] DEPRECATED: ${FLOW_DEPRECATED_MESSAGE}`);
  res.type('text/xml').send(generateDeprecationTwiML());
}

/**
 * Status callback for flow-based calls
 * This one is kept functional to handle status updates for any in-progress calls
 */
export async function handleFlowStatus(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  try {
    logger.info(`📊 [Flow Status] Received status update`);
    logger.info(`   Query params:`, req.query);
    logger.info(`   Body:`);

    const { executionId } = req.query;
    const { CallStatus, CallDuration } = req.body;

    if (!executionId) {
      logger.error(`❌ [Flow Status] Missing execution ID`);
      return res.sendStatus(200);
    }

    // Load execution
    const [execution] = await db
      .select()
      .from(flowExecutions)
      .where(eq(flowExecutions.id, executionId as string));

    if (!execution) {
      logger.error(`❌ [Flow Status] Execution not found: ${executionId}`);
      return res.sendStatus(200);
    }

    // If call completed and execution wasn't already marked complete
    if (CallStatus === 'completed' && execution.status === 'running') {
      await db
        .update(flowExecutions)
        .set({
          status: 'completed',
          completedAt: new Date(),
        })
        .where(eq(flowExecutions.id, executionId as string));

      logger.info(`✅ [Flow Status] Execution ${executionId} marked as completed`);
    }

    // Update call record if callId is available
    if (execution.callId && CallStatus) {
      const updateData: any = { status: CallStatus };
      if (CallStatus === 'completed' && CallDuration) {
        updateData.endedAt = new Date();
        updateData.duration = parseInt(CallDuration, 10);
      }

      await db
        .update(calls)
        .set(updateData)
        .where(eq(calls.id, execution.callId));
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('❌ [Flow Status] Error:', error);
    res.sendStatus(200);
  }
}
